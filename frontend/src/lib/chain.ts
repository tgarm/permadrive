// Chain interaction: connect (HTTP, no subscriptions, throttled throughout),
// block scanning for remarks, submission and final-state confirmation.
// No WS subscriptions because public nodes repeatedly drop with 1006 under
// continuous subscriptions/requests (observed). Confirmation strategy:
// confirmationDepth + canonical check — Autonomys finality can lag 15+ days,
// waiting for finalized is not viable.

import { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import { PacedHttpProvider, RawRpc, sleep, SubmitResultUnknownError } from './rpc.ts'
import { tryDecodeRemark } from './dag.ts'
import { t } from '../i18n/core.ts'

export interface ExtractResult {
  found: Map<string, Uint8Array> // cid string -> encoded node bytes
  parentHash: string
  height: number
}

export async function connectApi(
  url: string,
  { minIntervalMs = 1600, probeRetries = 8 }: { minIntervalMs?: number; probeRetries?: number } = {},
): Promise<ApiPromise> {
  // warm-up probe: rate-limit bans can last tens of minutes — check availability
  // with one light request first, so ApiPromise init does not slam a ban (and extend it)
  const probe = new RawRpc(url, { minIntervalMs: Math.max(minIntervalMs, 5000), maxRetries: probeRetries })
  await probe.call('system_chain', [])

  const provider = new PacedHttpProvider(url, { minIntervalMs })
  return ApiPromise.create({ provider, noInitWarn: true })
}

// Collect system.remark nodes from a set of calls (top-level extrinsics or
// utility.batch inner calls). AutoDrive submits one by one (top-level remark);
// we pack with utility.batch (remark nested one level) — both shapes must parse.
const collectRemarkNodes = (calls: unknown[], found: Map<string, Uint8Array>): void => {
  for (const wrapper of calls as { method?: unknown; args?: unknown[] }[]) {
    const w = wrapper as { method: unknown; section?: string; args: unknown[] }
    // a top-level extrinsic's .method is a Call object; utility.batch inner
    // elements are Calls themselves
    const call =
      w.method && typeof w.method === 'object' ? (w.method as { section: string; method: string }) : (w as { section: string; method: string })
    const args = (w.args ?? []) as unknown[]
    if (call.section === 'system' && call.method === 'remark') {
      const payload = new Uint8Array(args[0] as Uint8Array)
      // stripping the SCALE Bytes length prefix is not required: tryDecode
      // attempts the whole payload; the protocol payload is
      // compactAddLength(encoded) — decode args[0] directly like the PoC
      const decoded = tryDecodeRemark(payload)
      if (decoded) found.set(decoded.cid, payload)
    } else if (call.section === 'utility' && (call.method === 'batch' || call.method === 'batchAll')) {
      collectRemarkNodes(args[0] as unknown[], found)
    }
  }
}

// All system.remark nodes within one block (incl. utility.batch inner calls)
export async function extractRemarkNodes(api: ApiPromise, blockHash: string): Promise<ExtractResult> {
  const block = await api.rpc.chain.getBlock(blockHash)
  const found = new Map<string, Uint8Array>()
  collectRemarkNodes(block.block.extrinsics as unknown[], found)
  return {
    found,
    parentHash: block.block.header.parentHash.toHex(),
    height: block.block.header.number.toNumber(),
  }
}

export interface Inclusion {
  txHash: string
  blockHash: string
  height: number
}

// ---- structured submission errors (design review R02): callers distinguish downgrade / pending-verify / rejected ----

/** The node explicitly rejected (an RPC error response = received and not
 * accepted) — "banned" implies the same tx may already be in the pool or a
 * block; callers must not resend on this */
export class TxRejectedError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'TxRejectedError'
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

/** Submitted but result unknown (lost response/timeout) — never auto-resent;
 * verify by scanning the chain for the hash */
export class TxResultUnknownError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'TxResultUnknownError'
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

/** Not found within the scan window (may still be in the pool or an earlier
 * block) — carries recovery hints (txHash + start height); callers can persist
 * and rescan by hash; never auto-resent */
export class TxNotFoundError extends Error {
  txHash: string
  fromHeight: number
  constructor(message: string, { txHash, fromHeight }: { txHash: string; fromHeight: number }) {
    super(message)
    this.name = 'TxNotFoundError'
    this.txHash = txHash
    this.fromHeight = fromHeight
  }
}

/** The inclusion block was reorged away and the rescan window is exhausted — needs manual verification (the tx may have left the chain) */
export class InclusionLostError extends Error {
  txHash: string
  constructor(message: string, { txHash }: { txHash: string }) {
    super(message)
    this.name = 'InclusionLostError'
    this.txHash = txHash
  }
}

// The head observed pre-submit may lag the actual inclusion block (blocks minted
// or same-height forks between the head read and the submit) — the scan looks a
// few blocks before startHeight; the confirm phase no longer shares a deadline
// with the scan
const LOOKBACK_BLOCKS = 2
const REORG_RESCAN_BLOCKS = 8

/** Scan [fromHeight, best] for the tx hash (shared by recovery and verification) */
export async function findInclusionByHash(
  api: ApiPromise,
  txHash: string,
  fromHeight: number,
  { onStage }: { onStage?: (stage: string, detail?: string) => void } = {},
): Promise<Inclusion | null> {
  const header = await api.rpc.chain.getHeader()
  for (let h = Math.max(0, fromHeight); h <= header.number.toNumber(); h++) {
    const bh = await api.rpc.chain.getBlockHash(h)
    if (bh.toHex() === '0x' + '0'.repeat(64)) continue // fork boundaries may briefly return a zero hash — skip
    const signed = await api.rpc.chain.getBlock(bh)
    if (!signed?.block?.extrinsics) continue
    if (signed.block.extrinsics.some((ex) => ex.hash.toHex() === txHash)) {
      return { txHash, blockHash: bh.toHex(), height: h }
    }
  }
  onStage?.('scanning', `not in [${fromHeight}, ${header.number.toNumber()}]`)
  return null
}

// Submit a signed tx, scan the best chain for its inclusion block, then wait
// confirmationDepth subsequent blocks and verify the inclusion block is still
// canonical. A scan timeout does not mean a failed submission (it may be in the
// pool) — never blindly resend with the same nonce: Subspace dedups by
// (signer, nonce) and will temporarily ban.
export async function submitAndWaitConfirmed(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  {
    pollMs = 6000,
    scanTimeoutMs = 2 * 60_000,
    confirmTimeoutMs = 8 * 60_000,
    depth = 12,
    onStage,
  }: { pollMs?: number; scanTimeoutMs?: number; confirmTimeoutMs?: number; depth?: number; onStage?: (stage: string, detail?: string) => void } = {},
): Promise<Inclusion> {
  const txHash = tx.hash.toHex()
  // the start height must be read BEFORE submitting (reading the head only
  // after the submit misses already-included blocks)
  const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
  onStage?.('submitting', `${(tx.encodedLength / 1024).toFixed(1)} KiB, ${txHash.slice(0, 18)}…`)
  try {
    await api.rpc.author.submitExtrinsic(tx.toHex())
  } catch (e) {
    if (e instanceof SubmitResultUnknownError) {
      // transport failure (timeout/disconnect/empty) — the tx may have reached
      // the node; the result is unknown
      throw new TxResultUnknownError((e as Error).message, { cause: e })
    }
    // the node answered the submit request with an error = a definitive rejection
    // (incl. banned/1010/1012)
    throw new TxRejectedError((e as Error).message, { cause: e })
  }
  onStage?.('submitted') // a returned submit is not an included block: from here on it is "pending", never "not submitted"

  // 1) find the inclusion block on the best chain (small lookback from the
  // pre-submit head; zero hashes at fork boundaries are skipped)
  onStage?.('scanning')
  const inclusion = await scanUntilInclusion(api, txHash, Math.max(0, startHeight - LOOKBACK_BLOCKS), {
    scanTimeoutMs,
    pollMs,
    onStage,
  })
  if (!inclusion) {
    throw new TxNotFoundError(t('errors.txNotFoundTimeout'), { txHash, fromHeight: Math.max(0, startHeight - LOOKBACK_BLOCKS) })
  }

  // 2) wait depth subsequent blocks + canonical check (Nakamoto probabilistic
  // confirmation). A failed check = the inclusion block was reorged — rescan the
  // lookback window (the tx likely landed in a new block), give up after a few tries
  onStage?.('confirming', `block #${inclusion.height}`)
  const confirmDeadline = Date.now() + confirmTimeoutMs
  let current = inclusion
  for (let rescan = 1; ; rescan++) {
    const done = await waitConfirmed(api, current, { depth, confirmDeadline, pollMs })
    if (typeof done === 'boolean' && done) return current
    if (done === 'timeout') throw new TxNotFoundError('timeout waiting for confirmation depth', { txHash, fromHeight: current.height })
    // canonical check failed -> rewind the window and rescan
    if (rescan > 3) {
      throw new InclusionLostError(`inclusion block reorged away (tx ${txHash.slice(0, 18)}…, last seen at #${current.height})`, { txHash })
    }
    onStage?.('scanning', t('stage.reorgRescan', [rescan]))
    const found = await scanUntilInclusion(api, txHash, Math.max(0, current.height - REORG_RESCAN_BLOCKS), { scanTimeoutMs, pollMs, onStage })
    if (!found) throw new InclusionLostError('tx left the canonical chain after reorg', { txHash })
    current = found
    onStage?.('confirming', `block #${current.height}`)
  }
}

/** Poll until the inclusion block has depth subsequent blocks and is still canonical. Returns true=confirmed / 'timeout'=confirm window exhausted / false=canonical lost, rescan needed */
async function waitConfirmed(
  api: ApiPromise,
  inclusion: Inclusion,
  { depth, confirmDeadline, pollMs }: { depth: number; confirmDeadline: number; pollMs: number },
): Promise<boolean | 'timeout' | 'reorg'> {
  while (Date.now() < confirmDeadline) {
    const header = await api.rpc.chain.getHeader()
    if (header.number.toNumber() >= inclusion.height + depth) {
      const canonical = await api.rpc.chain.getBlockHash(inclusion.height)
      return canonical.toHex() === inclusion.blockHash ? true : 'reorg'
    }
    await sleep(pollMs)
  }
  return 'timeout'
}

/** Confirmation wait for a known inclusion (used by publish-task verification): reaches depth and stays canonical */
export async function waitInclusionConfirmed(
  api: ApiPromise,
  inclusion: Inclusion,
  { depth = 12, timeoutMs = 8 * 60_000, pollMs = 6000 }: { depth?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const r = await waitConfirmed(api, inclusion, { depth, confirmDeadline: Date.now() + timeoutMs, pollMs })
  return r === true
}

/** Repeatedly scan [fromHeight, best] until the deadline; returns the inclusion or null */
async function scanUntilInclusion(
  api: ApiPromise,
  txHash: string,
  fromHeight: number,
  { scanTimeoutMs, pollMs, onStage }: { scanTimeoutMs: number; pollMs: number; onStage?: (stage: string, detail?: string) => void },
): Promise<Inclusion | null> {
  const deadline = Date.now() + scanTimeoutMs
  let nextToCheck = Math.max(0, fromHeight)
  while (Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    for (let h = nextToCheck; h <= header.number.toNumber(); h++) {
      nextToCheck = h + 1
      const bh = await api.rpc.chain.getBlockHash(h)
      if (bh.toHex() === '0x' + '0'.repeat(64)) continue
      const signed = await api.rpc.chain.getBlock(bh)
      if (!signed?.block?.extrinsics) continue
      const hit = signed.block.extrinsics.find((ex) => ex.hash.toHex() === txHash)
      if (hit) return { txHash, blockHash: bh.toHex(), height: h }
    }
    await sleep(pollMs)
  }
  onStage?.('scanning', `not found up to #${nextToCheck - 1}`)
  return null
}
