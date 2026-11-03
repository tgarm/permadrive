// Publish pipeline (browser version of publish.mjs, in three phases so the UI
// can halt at the fee confirmation):
//   prepareUpload(file)     pack + sha256 (purely local, no network)
//   estimateFee(api, bytes) byteFee × total bytes — payment_queryInfo panics
//                           on large remarks (mainnet runtime bug), so use a
//                           first-order approximation
//   publishPrepared(...)    dynamic batching: remarks are grouped by an
//                           encoded-size budget (default 2 MB per batch),
//                           one wallet signature per batch, confirmed
//                           sequentially; "provably not sent" failures can be
//                           retried / shrunk / aborted interactively, anything
//                           else halts for verification → manifest v2
//
// R02 error model: submission failure ≠ not submitted. The publish task (tx
// hashes + start height + manifest reconstruction metadata) is persisted right
// after signing; every later failure is "result pending verification" — only
// hash-based rescanning (verifyPublishTask) is allowed, never automatic
// resubmission (same-nonce resubmission hits the (signer, nonce) dedup ban).
// Structured errors live in chain.ts (TxNotSent / TxRejected / TxResultUnknown
// / TxNotFound / InclusionLost).
//
// Second review (F02/F03): a partial per-tx publish must never be
// mistaken for a complete recovery — the task records the per-tx node plan
// (txNodes) and verification additionally proves on-chain coverage by
// extracting remark nodes from the confirmed blocks; the manifest is persisted
// in the SAME IndexedDB transaction that deletes the task.

import type { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import {
  TxNotSentError,
  TxRejectedError,
  extractRemarkNodes,
  remarkNodesFromExtrinsic,
  findInclusionByHash,
  submitAndWaitConfirmed,
  waitInclusionConfirmed,
  type Inclusion,
} from './chain.ts'
import { makeRemarkPayload, packFile, type PackedNode } from './dag.ts'
import type { Manifest, ManifestEncryption } from './manifest.ts'
import { sha256Hex } from './bytes.ts'
import {
  deletePublishTask,
  listPublishTasks,
  putManifestAndDeleteTask,
  putPublishTask,
  type PublishTaskRecord,
} from './store.ts'
import type { SubstrateSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

export interface PreparedUpload {
  file: { name: string; size: number; sha256: string; mimeType: string | null }
  rootCid: string
  nodes: PackedNode[]
  totalBytes: number
}

// ---- Dynamic batching (2026-11-03) ----
// The public gateways cap HTTP request bodies at ~15 MB (hex terms; 14 MB
// passes / 16 MB returns 413 on both domains, measured), and browser WS drops
// multi-MB messages silently — so remarks are grouped by an encoded-size
// budget, one wallet signature per batch. The budget is a mainnet-calibrated
// value: a 2.23 MB batchAll was accepted on-chain while 4.39 MB was rejected
// by the node (1010 "would exhaust the block limits" — the block limits bind
// before the gateway wall); 2 MB keeps a 10% margin so users never see a
// rejection prompt. A 2 MiB file is one batch, 8 MiB is five, 64 MiB is
// thirty-three. Official AutoDrive carries a single node per transaction
// (64 KiB, submitted concurrently) — the budget is still ~30x its per-tx size.
// The recovery envelope rides the last batch.
export const MAX_BATCH_ENCODED_BYTES = 2 * 1024 * 1024
/** Lower bound for the shrink fallback (user-facing chain 4 → 2 → 1 MB) */
export const MIN_BATCH_ENCODED_BYTES = 1024 * 1024

/** Group remarks by encoded length budget (pure function; a single remark is
 * ~65.5 KiB and always fits any workable budget, so groups are non-empty).
 * Returns the remark groups; the caller wraps them in batchAll/batch. */
export function planBatches<T>(items: T[], encodedLength: (item: T) => number, budget = MAX_BATCH_ENCODED_BYTES): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    if (current.length > 0 && bytes + encodedLength(item) > budget) {
      groups.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += encodedLength(item)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Estimate the batch count from total encoded bytes (confirmation-panel
 * preview; the exact count is planBatches at publish time) */
export const estimateBatchCount = (totalEncodedBytes: number, budget = MAX_BATCH_ENCODED_BYTES): number =>
  Math.max(1, Math.ceil(totalEncodedBytes / budget))

export interface ChunkFailureInfo {
  batchIndex: number
  totalBatches: number
  canShrink: boolean
  error: unknown
}

/** "Provably not sent" failures: a capacity rejection (a synchronous node
 * rejection proves non-acceptance) or a gateway 413/414 (the bytes never
 * reached the node). Only these allow retry/shrink — "result unknown" never
 * retries. */
const isShrinkableFailure = (e: unknown): boolean => {
  if (e instanceof TxNotSentError) return true
  if (e instanceof TxRejectedError) return BATCH_CAPACITY_RE.test(e.message) && !MAYBE_RECEIVED_RE.test(e.message)
  return false
}

export async function prepareUpload(file: File): Promise<PreparedUpload> {
  const [packed, sha256] = await Promise.all([packFile(file), sha256Hex(await file.arrayBuffer())])
  return {
    file: { name: file.name, size: file.size, sha256, mimeType: file.type || null },
    rootCid: packed.rootCid,
    nodes: packed.nodes,
    totalBytes: packed.nodes.reduce((a, n) => a + n.bytes.length, 0),
  }
}

// First-order fee approximation (measured on a 200 KB PoC: error negligible —
// the base fee contribution is negligible)
export async function estimateFee(api: ApiPromise, totalBytes: number): Promise<{ shannons: bigint; ai3: number }> {
  const fee = await api.query.transactionFees.transactionByteFee()
  const json = fee.toJSON() as { current?: string | number }
  const byteFee = BigInt(json.current ?? 0)
  const shannons = byteFee * BigInt(totalBytes)
  return { shannons, ai3: Number(shannons) / 1e18 }
}

/** A late wallet result must never resume the broadcast path after timeout. */
async function beforeBroadcastDeadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally { clearTimeout(timer) }
}

export type PublishStage = 'preparing-wallet' | 'signing' | 'submitting' | 'submitted' | 'scanning' | 'confirming'

// Degrade to per-tx only on the node's definitive capacity/format rejection of
// the batch, with no "may have been received" semantics. banned / not found /
// timeout / lost response never qualify — the tx may already be in the pool or
// a block, and resending the same nonce trips the dedup ban.
const BATCH_CAPACITY_RE = /too large|exceeds|exhaust|block capacity|requires? more weight|weight.{0,40}exceed|invalid transaction (version|format)|malformed/i
const MAYBE_RECEIVED_RE = /banned|already imported|usurped|future|not found|timeout/i

/**
 * Manifest assembly overrides (encrypted uploads): the DAG is packed from the
 * CIPHERTEXT, so prepared.file holds ciphertext metadata — manifest.file must
 * be overridden with the plaintext metadata (filenames/sizes are public), and
 * encryption carries the v2 block. file.sha256 is the plaintext sha256,
 * checked after decryption.
 */
export interface PublishOverrides {
  file?: Partial<Manifest['file']>
  encryption?: ManifestEncryption | null
  /** Version note (2026-11-03, optional): stored on-chain with the version content */
  note?: string
}

export async function publishPrepared(
  api: ApiPromise,
  prepared: PreparedUpload,
  signer: SubstrateSigner,
  onStage: (stage: PublishStage, detail?: string) => void,
  overrides: PublishOverrides = {},
  opts: { scanTimeoutMs?: number; confirmTimeoutMs?: number; depth?: number; walletTimeoutMs?: number; persist?: boolean; recovery?: PreparedUpload; confirmTransaction?: (submit: () => Promise<Inclusion>, batchIndex?: number, totalBatches?: number) => Promise<Inclusion>; beforeSign?: () => Promise<void>; onChunkFailure?: (info: ChunkFailureInfo) => Promise<'retry' | 'shrink' | 'abort'> } = {},
): Promise<Manifest> {
  const remarkTxs = (): SubmittableExtrinsic<'promise'>[] =>
    [...prepared.nodes, ...(opts.recovery?.nodes ?? [])].map((n) => api.tx.system.remark(makeRemarkPayload(n.bytes)))

  const taskId = `publish:${prepared.rootCid}`
  const persist = opts.persist ?? true
  // F03: the chain name is captured once at publish start and stored in the
  // task — rebuilding the manifest after confirmation no longer depends on a
  // trailing network call deciding whether credentials survive
  const chainName = (await beforeBroadcastDeadline(api.rpc.system.chain(), 90_000, t('walletSteps.rpcTimeout'))).toString()
  const startHeight = (await beforeBroadcastDeadline(api.rpc.chain.getHeader(), 90_000, t('walletSteps.rpcTimeout'))).number.toNumber()
  const task = (txHashes: string[], txNodes: number[], status: PublishTaskRecord['status'], lastError: string | null): PublishTaskRecord => ({
    id: taskId,
    kind: 'publish',
    rootCid: prepared.rootCid,
    file: prepared.file,
    overridesFile: overrides.file ? { ...overrides.file } : null,
    encryption: overrides.encryption ?? null,
    ...(overrides.note ? { note: overrides.note } : {}),
    nodes: prepared.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })),
    ...(opts.recovery ? { recovery: { manifestCid: opts.recovery.rootCid, nodes: opts.recovery.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })) } } : {}),
    totalBytes: prepared.totalBytes + (opts.recovery?.totalBytes ?? 0),
    startHeight,
    txHashes,
    txNodes,
    network: chainName,
    uploader: signer.address,
    persistManifest: persist,
    status,
    lastError,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const submitTx = async (
    tx: SubmittableExtrinsic<'promise'>,
    currentHashes: string[],
    currentNodes: number[],
    nodeCount: number,
    batchIndex = 0,
    totalBatches = 1,
  ): Promise<Inclusion> => {
    const submit = async () => {
      await opts.beforeSign?.()
      onStage('preparing-wallet')
      // Autonomys nonce semantics: accountNextIndex returning a huge value (about
      // the chain height) is normal — sign with it directly (same as the official backend)
      const nonce = (await beforeBroadcastDeadline(api.rpc.system.accountNextIndex(signer.address), 90_000, t('walletSteps.rpcTimeout'))).toNumber()
      onStage('signing', totalBatches > 1 ? `batch ${batchIndex + 1}/${totalBatches}` : undefined)
      // local signers sign with the KeyringPair (payload built by api.registry);
      // extension signers go through Signer.signPayload inside the wallet
      await beforeBroadcastDeadline(signer.pair
        ? tx.signAsync(signer.pair, { nonce })
        : tx.signAsync(signer.address, { signer: signer.signer!, nonce }),
        opts.walletTimeoutMs ?? 180_000, t('walletSteps.signTimeout'))
      // persist the task after signing, before submitting — from this moment a
      // "result unknown" is verifiable and recoverable; txNodes (aligned with
      // txHashes) records how many nodes each tx carries (F02)
      await putPublishTask(task([...currentHashes, tx.hash.toHex()], [...currentNodes, nodeCount], 'pending-verify', null))
      return submitAndWaitConfirmed(api, tx, { ...opts, onStage: (s) => onStage(s as PublishStage) })
    }
    return opts.confirmTransaction ? opts.confirmTransaction(submit, batchIndex, totalBatches) : submit()
  }

  const inclusions: Inclusion[] = []
  const remarks = remarkTxs()
  const nodeCounts: number[] = [] // remark count carried by each confirmed batch (F02 txNodes)
  let budget = MAX_BATCH_ENCODED_BYTES
  let offset = 0 // prefix length of remarks covered by confirmed batches
  while (offset < remarks.length) {
    const groups = planBatches(remarks.slice(offset), (tx) => tx.encodedLength, budget)
    const txs = groups.map((g) => (g.length > 1 ? (opts.recovery ? api.tx.utility.batchAll(g) : api.tx.utility.batch(g)) : g[0]))
    let i = 0
    while (i < txs.length) {
      try {
        inclusions.push(await submitTx(txs[i], inclusions.map((x) => x.txHash), [...nodeCounts], groups[i].length, i, txs.length))
        nodeCounts.push(groups[i].length)
        offset += groups[i].length
        i++
      } catch (e) {
        if (!isShrinkableFailure(e)) throw e // result unknown / other rejection: the task is persisted (incl. the failed batch hash, possibly pooled) — rescan by hash
        if (opts.recovery) {
          // multi-batch + recovery (main path): provably not sent → interactive decision
          if (!opts.onChunkFailure) throw e
          const decision = await opts.onChunkFailure({ batchIndex: i, totalBatches: txs.length, canShrink: budget > MIN_BATCH_ENCODED_BYTES, error: e })
          if (decision === 'abort') {
            // the failed batch's hash was persisted after signing — provably not
            // sent, strip the phantom hash before halting
            await putPublishTask(task(inclusions.map((x) => x.txHash), [...nodeCounts], 'pending-verify', (e as Error).message))
            throw e
          }
          if (decision === 'shrink' && budget > MIN_BATCH_ENCODED_BYTES) {
            budget = Math.max(MIN_BATCH_ENCODED_BYTES, Math.floor(budget / 2))
            onStage('signing', t('stage.batchShrink', [(budget / (1024 * 1024)).toFixed(1)]))
            break // the outer while regroups the uncovered remarks at the new budget (confirmed batches are never resent or repaid)
          }
          continue // retry: re-sign and resubmit the same batch (provably not sent → safe)
        }
        // no-recovery path (legacy: manifest-file publishing and other tiny
        // manifests): definitive capacity rejection → degrade to per-tx for the
        // uncovered remarks (confirmed batch hashes are kept; F02 unchanged)
        await putPublishTask(task(inclusions.map((x) => x.txHash), [...nodeCounts], 'pending-verify', `batch rejected: ${(e as Error).message}`))
        onStage('signing', t('stage.batchFallback'))
        for (const tx of remarks.slice(offset)) {
          const inc = await submitTx(tx, inclusions.map((x) => x.txHash), inclusions.map(() => 1), 1)
          inclusions.push(inc)
        }
        offset = remarks.length
        break
      }
    }
  }

  // F02/F03: build the manifest first (local metadata, no network calls), then
  // persist it in the same transaction that deletes the task — if persistence
  // fails the task stays pending-verify and no credential is lost
  const manifest: Manifest = {
    ...(opts.recovery ? { recovery: { manifestCid: opts.recovery.rootCid } } : {}),
    version: 2, // new publishes are v2 from here (encryption null = plain upload, a v1 superset)
    ...(overrides.note ? { note: overrides.note } : {}),
    network: /mainnet/i.test(chainName) ? 'mainnet' : chainName,
    rootCid: prepared.rootCid,
    file: { ...prepared.file, ...overrides.file },
    encryption: overrides.encryption ?? null,
    compression: null,
    uploader: { address: signer.address },
    nodes: prepared.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })),
    txs: inclusions,
    submittedAt: new Date().toISOString(),
  }
  if (persist) await putManifestAndDeleteTask(manifest, taskId)
  else await deletePublishTask(taskId) // the manifest file itself: not listed as a file
  return manifest
}

// ---- "pending verification" recovery (design review) ----

/** All publish tasks pending verification (refresh on page load / after a failed publish) */
export const listPendingPublish = (): Promise<PublishTaskRecord[]> =>
  listPublishTasks().then((all) => all.filter((x) => x.status === 'pending-verify'))

/** Dismiss a pending task (the content may be on-chain — re-uploading after dismissal pays the byte fee again) */
export const dismissPendingPublish = (task: PublishTaskRecord): Promise<void> => deletePublishTask(task.id)

/** Verify by rescanning hashes: every tx found, confirmed, AND its block proven
 * to carry all of the task's node CIDs (F02) → rebuild the manifest from the
 * task metadata and persist it in the same transaction that deletes the task
 * (F03); otherwise return null (transient → retry later; permanent gap → the
 * task is kept with lastError set) */
export async function verifyPublishTask(
  api: ApiPromise,
  record: PublishTaskRecord,
  opts: { depth?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<Manifest | null> {
  // F02: an empty task (crashed after the capacity rejection, before the first
  // signature) = this task never submitted anything; an empty loop "succeeding"
  // was a false recovery — refuse and mark
  if (record.txHashes.length === 0) {
    await markTaskError(record, t('publishPending.emptyTask'))
    return null
  }
  // F02: incomplete plan (per-tx signing/submitting stopped partway) → the
  // missing nodes were never submitted by this task, so it cannot complete
  // (a same-content republish lands its own manifest via its own path)
  const expectedNodes = [...record.nodes, ...(record.recovery?.nodes ?? [])]
  if (record.recovery && record.txHashes.length !== 1) {
    await markTaskError(record, t('errors.recoveryBatchIncomplete'))
    return null
  }
  if (record.txNodes) {
    const planned = record.txNodes.reduce((a, b) => a + b, 0)
    if (record.txHashes.length !== record.txNodes.length || planned !== expectedNodes.length) {
      const missing = Math.max(0, expectedNodes.length - planned)
      await markTaskError(record, t('publishPending.incomplete', [String(missing)]))
      return null
    }
  }
  const inclusions: Inclusion[] = []
  for (const txHash of record.txHashes) {
    const inclusion = await findInclusionByHash(api, txHash, record.startHeight)
    if (!inclusion) return null
    const confirmed = await waitInclusionConfirmed(api, inclusion, { depth: opts.depth ?? 12, timeoutMs: opts.timeoutMs ?? 8 * 60_000, pollMs: opts.pollMs })
    if (!confirmed) return null
    inclusions.push(inclusion)
  }
  // F02: on-chain proof of coverage — extract the remark nodes (batch inner
  // calls included) from every confirmed tx's block; every expected node CID
  // must be extractable (other people's nodes in the same block are a superset,
  // not a gap). For legacy tasks (no txNodes mapping) this is the only
  // reliable check.
  const found = new Map<string, Uint8Array>()
  for (const inclusion of inclusions) {
    if (record.recovery) {
      const block = await api.rpc.chain.getBlock(inclusion.blockHash)
      const extrinsic = block.block.extrinsics.find((ex) => ex.hash.toHex() === inclusion.txHash)
      if (extrinsic) for (const [cid, payload] of remarkNodesFromExtrinsic(extrinsic)) found.set(cid, payload)
    } else {
      const { found: blockNodes } = await extractRemarkNodes(api, inclusion.blockHash)
      for (const [cid, payload] of blockNodes) found.set(cid, payload)
    }
  }
  const missing = expectedNodes.filter((n) => !found.has(n.cid))
  if (missing.length > 0) {
    await markTaskError(record, t('publishPending.coverageGap', [String(missing.length), String(expectedNodes.length)]))
    return null
  }
  // F03: network/uploader come from values captured in the task (legacy tasks
  // fall back to one network call); the manifest and the task deletion commit
  // in one transaction — a failed write keeps the task, so credentials survive
  const chainName = record.network ?? (await api.rpc.system.chain()).toString()
  const manifest: Manifest = {
    ...(record.recovery ? { recovery: { manifestCid: record.recovery.manifestCid } } : {}),
    version: 2,
    ...(record.note ? { note: record.note } : {}),
    network: /mainnet/i.test(chainName) ? 'mainnet' : chainName,
    rootCid: record.rootCid,
    file: { ...record.file, ...(record.overridesFile as Partial<Manifest['file']> | null) } as Manifest['file'],
    encryption: (record.encryption as ManifestEncryption | null) ?? null,
    compression: null,
    uploader: { address: record.uploader ?? '' }, // legacy tasks have no uploader (irrelevant for retrieval)
    nodes: record.nodes,
    txs: inclusions,
    submittedAt: new Date(record.createdAt).toISOString(),
  }
  if (record.persistManifest ?? true) await putManifestAndDeleteTask(manifest, record.id)
  else await deletePublishTask(record.id) // the manifest file itself: not listed as a file
  return manifest
}

/** Permanent verification failure: the task is kept but marked with the reason
 * (shown in the UI; transient failures are not marked) */
async function markTaskError(record: PublishTaskRecord, message: string): Promise<void> {
  await putPublishTask({ ...record, lastError: message, updatedAt: Date.now() })
}
