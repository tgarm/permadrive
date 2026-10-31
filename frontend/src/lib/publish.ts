// Publish pipeline (browser version of publish.mjs, in three phases so the UI
// can halt at the fee confirmation):
//   prepareUpload(file)     pack + sha256 (purely local, no network)
//   estimateFee(api, bytes) byteFee × total bytes — payment_queryInfo panics
//                           on large remarks (mainnet runtime bug), so use a
//                           first-order approximation
//   publishPrepared(...)    wallet signs → utility.batch single tx preferred;
//                           degrade to per-tx only on a definitive capacity/
//                           format rejection proven not received →
//                           confirmationDepth confirmation → manifest v2
//
// R02 error model: submission failure ≠ not submitted. The publish task (tx
// hashes + start height + manifest reconstruction metadata) is persisted right
// after signing; every later failure is "result pending verification" — only
// hash-based rescanning (verifyPublishTask) is allowed, never automatic
// resubmission (same-nonce resubmission hits the (signer, nonce) dedup ban).
// Structured errors live in chain.ts (TxRejected / TxResultUnknown / TxNotFound
// / InclusionLost).
//
// Second review (F02/F03): a partial per-tx publish must never be
// mistaken for a complete recovery — the task records the per-tx node plan
// (txNodes) and verification additionally proves on-chain coverage by
// extracting remark nodes from the confirmed blocks; the manifest is persisted
// in the SAME IndexedDB transaction that deletes the task.

import type { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import {
  TxRejectedError,
  extractRemarkNodes,
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

export type PublishStage = 'signing' | 'submitting' | 'submitted' | 'scanning' | 'confirming'

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
}

export async function publishPrepared(
  api: ApiPromise,
  prepared: PreparedUpload,
  signer: SubstrateSigner,
  onStage: (stage: PublishStage, detail?: string) => void,
  overrides: PublishOverrides = {},
  opts: { scanTimeoutMs?: number; confirmTimeoutMs?: number; depth?: number; persist?: boolean } = {},
): Promise<Manifest> {
  const remarkTxs = (): SubmittableExtrinsic<'promise'>[] =>
    prepared.nodes.map((n) => api.tx.system.remark(makeRemarkPayload(n.bytes)))

  const taskId = `publish:${prepared.rootCid}`
  const persist = opts.persist ?? true
  // F03: the chain name is captured once at publish start and stored in the
  // task — rebuilding the manifest after confirmation no longer depends on a
  // trailing network call deciding whether credentials survive
  const chainName = (await api.rpc.system.chain()).toString()
  const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
  const task = (txHashes: string[], txNodes: number[], status: PublishTaskRecord['status'], lastError: string | null): PublishTaskRecord => ({
    id: taskId,
    kind: 'publish',
    rootCid: prepared.rootCid,
    file: prepared.file,
    overridesFile: overrides.file ? { ...overrides.file } : null,
    encryption: overrides.encryption ?? null,
    nodes: prepared.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })),
    totalBytes: prepared.totalBytes,
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
  ): Promise<Inclusion> => {
    onStage('signing')
    // Autonomys nonce semantics: accountNextIndex returning a huge value (about
    // the chain height) is normal — sign with it directly (same as the official backend)
    const nonce = (await api.rpc.system.accountNextIndex(signer.address)).toNumber()
    // local signers sign with the KeyringPair (payload built by api.registry);
    // extension signers go through Signer.signPayload inside the wallet
    if (signer.pair) await tx.signAsync(signer.pair, { nonce })
    else await tx.signAsync(signer.address, { signer: signer.signer!, nonce })
    // persist the task after signing, before submitting — from this moment a
    // "result unknown" is verifiable and recoverable; txNodes (aligned with
    // txHashes) records how many nodes each tx carries (F02)
    await putPublishTask(task([...currentHashes, tx.hash.toHex()], [...currentNodes, nodeCount], 'pending-verify', null))
    return submitAndWaitConfirmed(api, tx, { ...opts, onStage: (s) => onStage(s as PublishStage) })
  }

  const inclusions: Inclusion[] = []
  try {
    const batch = api.tx.utility.batch(remarkTxs())
    inclusions.push(await submitTx(batch, [], [], prepared.nodes.length))
  } catch (e) {
    const message = (e as Error).message ?? ''
    const rejected = e instanceof TxRejectedError
    const capacityReject = rejected && BATCH_CAPACITY_RE.test(message) && !MAYBE_RECEIVED_RE.test(message)
    if (!capacityReject) {
      // pending verification (submitted but timed out / lost response / confirm
      // failed) or another definitive rejection (banned etc.): the task is
      // persisted — rescan by hash; never degrade and resend
      throw e
    }
    // definitive capacity/format rejection (a synchronous node rejection proves
    // non-acceptance) → drop the batch hash, degrade to per-tx
    await putPublishTask(task([], [], 'pending-verify', `batch rejected: ${message}`))
    onStage('signing', t('stage.batchFallback'))
    for (const tx of remarkTxs()) {
      const inc = await submitTx(tx, inclusions.map((i) => i.txHash), inclusions.map(() => 1), 1)
      inclusions.push(inc)
    }
  }

  // F02/F03: build the manifest first (local metadata, no network calls), then
  // persist it in the same transaction that deletes the task — if persistence
  // fails the task stays pending-verify and no credential is lost
  const manifest: Manifest = {
    version: 2, // new publishes are v2 from here (encryption null = plain upload, a v1 superset)
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
  if (record.txNodes) {
    const planned = record.txNodes.reduce((a, b) => a + b, 0)
    if (record.txHashes.length !== record.txNodes.length || planned !== record.nodes.length) {
      const missing = Math.max(0, record.nodes.length - planned)
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
    const { found: blockNodes } = await extractRemarkNodes(api, inclusion.blockHash)
    for (const [cid, payload] of blockNodes) found.set(cid, payload)
  }
  const missing = record.nodes.filter((n) => !found.has(n.cid))
  if (missing.length > 0) {
    await markTaskError(record, t('publishPending.coverageGap', [String(missing.length), String(record.nodes.length)]))
    return null
  }
  // F03: network/uploader come from values captured in the task (legacy tasks
  // fall back to one network call); the manifest and the task deletion commit
  // in one transaction — a failed write keeps the task, so credentials survive
  const chainName = record.network ?? (await api.rpc.system.chain()).toString()
  const manifest: Manifest = {
    version: 2,
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
