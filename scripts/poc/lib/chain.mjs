// Chain interaction: connection (HTTP, no subscriptions, throttled throughout), block scanning to
// extract remarks, submission and finality confirmation.
// Why no WS subscriptions: public nodes repeatedly drop with 1006 under continuous
// subscriptions/requests (measured); polling + throttling is more stable. Finality is judged via
// chain_getFinalizedHead (stronger than AutoDrive's confirmationDepth probabilistic confirmation).

import { ApiPromise } from '@polkadot/api'
import { PacedHttpProvider, sleep } from './rpc.mjs'
import { cidOfNode, cidToString, tryDecodeRemark } from './dag.mjs'

// taurus was retired by the official team around 2026-10-25 (DNS withdrawn); the testnet migrated
// to chronos; indexer.taurus.autonomys.xyz is still online and (unverified) serves the same chain.
export const CHAIN_RPC = process.env.CHAIN_RPC ?? 'https://rpc.chronos.autonomys.xyz/ws'
export const CHAIN_INDEXER = process.env.CHAIN_INDEXER ?? 'wss://indexer.taurus.autonomys.xyz/ws'

export async function connectApi(url = CHAIN_RPC) {
  // Warm-up probe: rate-limit bans can last tens of minutes, so fire a single lightweight request
  // first to confirm availability, keeping the burst of requests during ApiPromise init from all
  // landing on the ban (which would also prolong it)
  const { RawRpc } = await import('./rpc.mjs')
  const probe = new RawRpc(url, { minIntervalMs: 5000, maxRetries: 60 })
  console.log(`probing ${url} …`)
  const chainName = await probe.call('system_chain', [])
  console.log(`probe ok: ${chainName}`)

  const provider = new PacedHttpProvider(url, {
    minIntervalMs: Number(process.env.RPC_MIN_INTERVAL_MS ?? 1600),
  })
  const api = await ApiPromise.create({ provider, noInitWarn: true })
  console.log(`connected: ${chainName} via ${url}`)
  return api
}

// sr25519 KeyringPair loading (the @polkadot/* deps live in this directory's node_modules —
// external scripts go through this helper instead of resolving @polkadot/api themselves)
export async function srPairFromMnemonic(mnemonic) {
  const { cryptoWaitReady } = await import('@polkadot/util-crypto')
  await cryptoWaitReady()
  const keyring = new Keyring({ type: 'sr25519' })
  return keyring.addFromMnemonic(mnemonic)
}

// Collect system.remark nodes from a set of calls (top-level extrinsics or utility.batch inner calls).
// AutoDrive submits per-tx (the top level is the remark); we pack via utility.batch (remark nested
// one level deep) — both shapes must be recognized.
const collectRemarkNodes = (calls, found) => {
  for (const wrapper of calls) {
    // A top-level extrinsic's .method is a Call object; a utility.batch inner element is itself a
    // Call (its .method is the method-name string) — normalize both into {section, method, args}
    const call = wrapper.method && typeof wrapper.method === 'object' ? wrapper.method : wrapper
    if (call.section === 'system' && call.method === 'remark') {
      const decoded = tryDecodeRemark(wrapper.args[0])
      if (decoded)
        found.set(cidToString(decoded.cid), {
          bytes: Buffer.from(wrapper.args[0]),
          node: decoded.node,
        })
    } else if (call.section === 'utility' && (call.method === 'batch' || call.method === 'batchAll')) {
      collectRemarkNodes([...wrapper.args[0]], found)
    }
  }
}

// Node-decoded result of every system.remark in one block (including utility.batch inner calls): Map<cidString, {bytes, node}>
export async function extractRemarkNodes(api, blockHash) {
  const block = await api.rpc.chain.getBlock(blockHash)
  const found = new Map()
  collectRemarkNodes(block.block.extrinsics, found)
  return { block, found }
}

// Walk back count blocks from the start block (inclusive), invoking the callback per block with {blockHash, height, found}
export async function walkBlocksBack(api, startHash, count, onBlock) {
  let hash = startHash
  for (let i = 0; i < count; i++) {
    const { block, found } = await extractRemarkNodes(api, hash)
    const height = block.block.header.number.toNumber()
    await onBlock({ hash, height, found, block })
    hash = block.block.header.parentHash
  }
}

// Wait side for an ALREADY-SUBMITTED tx (the caller is responsible for exactly one
// author.submitExtrinsic): scan the best chain for the inclusion block, then wait for
// confirmationDepth subsequent blocks and verify the inclusion block is still canonical.
// Finality on this chain can lag by days, so waiting for finalized is not viable;
// this matches the AutoDrive backend's anti-reorg policy (onchainPublisher/confirmation.ts).
// Single-submission discipline: submission and waiting must be split — resubmitting the
// same tx with the same nonce hits the (signer, nonce) dedup ban; a scan timeout does NOT
// mean the submission failed — it can only be marked unknown and verified by a human.
// Returns { txHash, blockHash, height }
export async function awaitConfirmed(
  api,
  txHash,
  { startHeight, pollMs = 6000, timeoutMs = 8 * 60_000, depth = 12 } = {},
) {
  // 1) Find the inclusion block on the best chain (remember already-scanned heights to avoid
  //    rescanning; fork boundaries in production may briefly return a zero hash → skip that
  //    height instead of crashing)
  const from = startHeight ?? (await api.rpc.chain.getHeader()).number.toNumber()
  let nextToCheck = from
  let inclusion = null
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
      if (hit) inclusion = { blockHash: bh.toHex(), height: h }
    }
    if (!inclusion) await sleep(pollMs)
  }
  if (!inclusion)
    throw new Error(
      'tx not found on best chain before timeout (it may still be in the mempool — do NOT resubmit with the same nonce; check author_pendingExtrinsics)',
    )

  // 2) Wait for depth subsequent blocks + canonical check (Nakamoto probabilistic confirmation)
  while (Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    if (header.number.toNumber() >= inclusion.height + depth) {
      const canonical = await api.rpc.chain.getBlockHash(inclusion.height)
      if (canonical.toHex() === inclusion.blockHash)
        return { txHash, ...inclusion, confirmedDepth: depth }
      throw new Error(
        `inclusion block reorged away (${inclusion.blockHash} → ${canonical.toHex()})`,
      )
    }
    await sleep(pollMs)
  }
  throw new Error('timeout waiting for confirmation depth')
}

// Submit the signed tx exactly once, then hand over to awaitConfirmed for confirmation.
// Returns { txHash, blockHash, height }
export async function submitAndWaitConfirmed(
  api,
  tx,
  { pollMs = 6000, timeoutMs = 8 * 60_000, depth = 12 } = {},
) {
  const txHash = tx.hash.toHex()
  console.log(`  submitting ${txHash} (${(tx.encodedLength / 1024).toFixed(1)} KiB)…`)
  await api.rpc.author.submitExtrinsic(tx.toHex())
  const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
  return awaitConfirmed(api, txHash, { startHeight, pollMs, timeoutMs, depth })
}
