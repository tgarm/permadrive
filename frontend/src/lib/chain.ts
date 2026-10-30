// Chain interaction: connection (HTTP, no subscriptions, throttled end to end),
// block scanning for remark extraction, submission and finality confirmation.
// Why no WS subscriptions: public nodes repeatedly drop with 1006 under
// continuous subscriptions/requests (measured).
// Confirmation policy: confirmationDepth + canonical check — Autonomys finality
// can lag 15 days or more, so waiting for finalized is not viable (known pitfall).

import { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import { PacedHttpProvider, RawRpc, sleep } from './rpc'
import { tryDecodeRemark } from './dag'
import { t } from '../i18n/core.ts'

export interface ExtractResult {
  found: Map<string, Uint8Array> // cidString → encoded node bytes
  parentHash: string
  height: number
}

export async function connectApi(
  url: string,
  { minIntervalMs = 1600, probeRetries = 8 }: { minIntervalMs?: number; probeRetries?: number } = {},
): Promise<ApiPromise> {
  // Warm-up probe: a rate-limit ban can last tens of minutes, so send one
  // lightweight request first to confirm availability instead of letting the
  // burst of ApiPromise init requests all hit the ban (which also extends it)
  const probe = new RawRpc(url, { minIntervalMs: Math.max(minIntervalMs, 5000), maxRetries: probeRetries })
  await probe.call('system_chain', [])

  const provider = new PacedHttpProvider(url, { minIntervalMs })
  return ApiPromise.create({ provider, noInitWarn: true })
}

// Collect system.remark nodes from a set of calls (top-level extrinsics or the
// inner calls of utility.batch). AutoDrive submits one extrinsic at a time
// (remark at top level); we pack via utility.batch (remark nested one level),
// so both shapes must be recognized.
const collectRemarkNodes = (calls: unknown[], found: Map<string, Uint8Array>): void => {
  for (const wrapper of calls as { method?: unknown; args?: unknown[] }[]) {
    const w = wrapper as { method: unknown; section?: string; args: unknown[] }
    // A top-level extrinsic's .method is a Call object; utility.batch inner
    // elements are already Call objects themselves
    const call =
      w.method && typeof w.method === 'object' ? (w.method as { section: string; method: string }) : (w as { section: string; method: string })
    const args = (w.args ?? []) as unknown[]
    if (call.section === 'system' && call.method === 'remark') {
      const payload = new Uint8Array(args[0] as Uint8Array)
      // Stripping the SCALE Bytes length prefix is not required: tryDecode
      // attempts the whole payload, but the protocol convention is
      // payload = compactAddLength(encoded), so decode args[0] directly as in the PoC
      const decoded = tryDecodeRemark(payload)
      if (decoded) found.set(decoded.cid, payload)
    } else if (call.section === 'utility' && (call.method === 'batch' || call.method === 'batchAll')) {
      collectRemarkNodes(args[0] as unknown[], found)
    }
  }
}

// Node-level extraction of every system.remark in one block (including utility.batch inner calls)
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

// Submit a signed tx, scan the best chain for its inclusion block, then wait
// for confirmationDepth following blocks and verify the inclusion block is
// still canonical. Timeout without finding it ≠ submission failed (it may
// still be in the pool); never blindly resubmit with the same nonce —
// Subspace dedupes by (signer, nonce) and will report "temporarily banned".
export async function submitAndWaitConfirmed(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  { pollMs = 6000, timeoutMs = 8 * 60_000, depth = 12, onStage }: { pollMs?: number; timeoutMs?: number; depth?: number; onStage?: (stage: string, detail?: string) => void } = {},
): Promise<Inclusion> {
  const txHash = tx.hash.toHex()
  onStage?.('submitting', `${(tx.encodedLength / 1024).toFixed(1)} KiB, ${txHash.slice(0, 18)}…`)
  await api.rpc.author.submitExtrinsic(tx.toHex())

  // 1) Find the inclusion block on the best chain (fork boundaries may briefly
  //    return a zero hash → skip that height)
  onStage?.('scanning')
  const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
  let nextToCheck = startHeight
  let inclusion: Inclusion | null = null
  const deadline = Date.now() + timeoutMs
  while (!inclusion && Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    for (let h = nextToCheck; h <= header.number.toNumber() && !inclusion; h++) {
      nextToCheck = h + 1
      const bh = await api.rpc.chain.getBlockHash(h)
      if (bh.toHex() === '0x' + '0'.repeat(64)) continue
      const signed = await api.rpc.chain.getBlock(bh)
      if (!signed?.block?.extrinsics) continue
      const hit = signed.block.extrinsics.find((ex) => ex.hash.toHex() === txHash)
      if (hit) inclusion = { txHash, blockHash: bh.toHex(), height: h }
    }
    if (!inclusion) await sleep(pollMs)
  }
  if (!inclusion) throw new Error(t('errors.txNotFoundTimeout'))

  // 2) Wait for `depth` following blocks + canonical check (Nakamoto probabilistic confirmation)
  onStage?.('confirming', `block #${inclusion.height}`)
  while (Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    if (header.number.toNumber() >= inclusion.height + depth) {
      const canonical = await api.rpc.chain.getBlockHash(inclusion.height)
      if (canonical.toHex() === inclusion.blockHash)
        return { ...inclusion, blockHash: inclusion.blockHash }
      throw new Error(`inclusion block reorged away (${inclusion.blockHash} → ${canonical.toHex()})`)
    }
    await sleep(pollMs)
  }
  throw new Error('timeout waiting for confirmation depth')
}
