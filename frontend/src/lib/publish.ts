// Publish pipeline (browser version of publish.mjs, in three phases so the UI
// can halt at the fee confirmation):
//   prepareUpload(file)     pack + sha256 (purely local, no network)
//   estimateFee(api, bytes) byteFee × total bytes — payment_queryInfo panics
//                           on large remarks (mainnet runtime bug), so use a
//                           first-order approximation
//   publishPrepared(...)    wallet signs → utility.batch single tx preferred;
//                           if the node rejects it, fall back to signing each
//                           tx individually (measured on mainnet: 1 MB ≈ 17 nodes in a
//                           single tx was untested at the time; batched per-tx
//                           submission is a normal path, not an error) →
//                           confirmationDepth confirmation → manifest v1

import type { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import {
  TxRejectedError,
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
  opts: { scanTimeoutMs?: number; confirmTimeoutMs?: number; depth?: number } = {},
): Promise<Manifest> {
  const remarkTxs = (): SubmittableExtrinsic<'promise'>[] =>
    prepared.nodes.map((n) => api.tx.system.remark(makeRemarkPayload(n.bytes)))

  const taskId = `publish:${prepared.rootCid}`
  const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
  const task = (txHashes: string[], status: PublishTaskRecord['status'], lastError: string | null): PublishTaskRecord => ({
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
    status,
    lastError,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const submitTx = async (tx: SubmittableExtrinsic<'promise'>, currentHashes: string[]): Promise<Inclusion> => {
    onStage('signing')
    // Autonomys nonce semantics: accountNextIndex returning a huge value (about
    // the chain height) is normal — sign with it directly (same as the official backend)
    const nonce = (await api.rpc.system.accountNextIndex(signer.address)).toNumber()
    // local signers sign with the KeyringPair (payload built by api.registry);
    // extension signers go through Signer.signPayload inside the wallet
    if (signer.pair) await tx.signAsync(signer.pair, { nonce })
    else await tx.signAsync(signer.address, { signer: signer.signer!, nonce })
    // persist the task after signing, before submitting — from this moment a
    // "result unknown" is verifiable and recoverable
    await putPublishTask(task([...currentHashes, tx.hash.toHex()], 'pending-verify', null))
    return submitAndWaitConfirmed(api, tx, { ...opts, onStage: (s) => onStage(s as PublishStage) })
  }

  const inclusions: Inclusion[] = []
  try {
    const batch = api.tx.utility.batch(remarkTxs())
    inclusions.push(await submitTx(batch, []))
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
    await putPublishTask(task([], 'pending-verify', `batch rejected: ${message}`))
    onStage('signing', t('stage.batchFallback'))
    for (const tx of remarkTxs()) {
      const inc = await submitTx(tx, inclusions.map((i) => i.txHash))
      inclusions.push(inc)
    }
  }

  // everything confirmed: remove the recovery task (the manifest itself is the
  // persistent credential)
  await deletePublishTask(taskId)

  const chainName = (await api.rpc.system.chain()).toString()
  return {
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
}

// ---- "pending verification" recovery (design review) ----

/** All publish tasks pending verification (refresh on page load / after a failed publish) */
export const listPendingPublish = (): Promise<PublishTaskRecord[]> =>
  listPublishTasks().then((all) => all.filter((x) => x.status === 'pending-verify'))

/** Dismiss a pending task (the content may be on-chain — re-uploading after dismissal pays the byte fee again) */
export const dismissPendingPublish = (task: PublishTaskRecord): Promise<void> => deletePublishTask(task.id)

/** Verify by rescanning hashes: once every tx is found and confirmed, rebuild the manifest from the task metadata and persist it (no republish, no byte fee); otherwise return null (still undetermined, try later) */
export async function verifyPublishTask(
  api: ApiPromise,
  record: PublishTaskRecord,
  opts: { depth?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<Manifest | null> {
  const inclusions: Inclusion[] = []
  for (const txHash of record.txHashes) {
    const inclusion = await findInclusionByHash(api, txHash, record.startHeight)
    if (!inclusion) return null
    const confirmed = await waitInclusionConfirmed(api, inclusion, { depth: opts.depth ?? 12, timeoutMs: opts.timeoutMs ?? 8 * 60_000, pollMs: opts.pollMs })
    if (!confirmed) return null
    inclusions.push(inclusion)
  }
  const chainName = (await api.rpc.system.chain()).toString()
  const manifest: Manifest = {
    version: 2,
    network: /mainnet/i.test(chainName) ? 'mainnet' : chainName,
    rootCid: record.rootCid,
    file: { ...record.file, ...(record.overridesFile as Partial<Manifest['file']> | null) } as Manifest['file'],
    encryption: (record.encryption as ManifestEncryption | null) ?? null,
    compression: null,
    uploader: { address: '' }, // rebuilt scenario: the uploader address is not in the task (irrelevant for retrieval)
    nodes: record.nodes,
    txs: inclusions,
    submittedAt: new Date(record.createdAt).toISOString(),
  }
  await deletePublishTask(record.id)
  return manifest
}
