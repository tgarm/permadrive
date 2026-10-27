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
import { submitAndWaitConfirmed } from './chain'
import { makeRemarkPayload, packFile, type PackedNode } from './dag'
import type { ManifestV1 } from './manifest'
import { sha256Hex } from './bytes'
import type { SubstrateSigner } from './wallet/types'
import { t } from '../i18n'

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

export type PublishStage = 'signing' | 'submitting' | 'scanning' | 'confirming'

export async function publishPrepared(
  api: ApiPromise,
  prepared: PreparedUpload,
  signer: SubstrateSigner,
  onStage: (stage: PublishStage, detail?: string) => void,
): Promise<ManifestV1> {
  const remarkTxs = (): SubmittableExtrinsic<'promise'>[] =>
    prepared.nodes.map((n) => api.tx.system.remark(makeRemarkPayload(n.bytes)))

  const submitTx = async (tx: SubmittableExtrinsic<'promise'>) => {
    onStage('signing')
    // Autonomys nonce semantics: accountNextIndex returning a huge value
    // (≈ chain height) is normal — sign with it directly (same approach as the
    // official backend)
    const nonce = (await api.rpc.system.accountNextIndex(signer.address)).toNumber()
    // The local path signs directly with a KeyringPair (payload built by
    // api.registry); the extension path goes through Signer.signPayload with
    // signing inside the wallet
    if (signer.pair) await tx.signAsync(signer.pair, { nonce })
    else await tx.signAsync(signer.address, { signer: signer.signer!, nonce })
    return submitAndWaitConfirmed(api, tx, { onStage: (s) => onStage(s as PublishStage) })
  }

  // batch first (one signature carries all nodes); fall back to per-tx only
  // when rejected with something other than banned/not-found.
  // Submission failure ≠ publish failure: banned/not-found errors mean the tx
  // may already be in the pool, and blindly resubmitting the same nonce hits
  // the (signer, nonce) dedup — rethrow and let the user fall back to retrieval.
  const inclusions: { txHash: string; blockHash: string; height: number }[] = []
  try {
    inclusions.push(await submitTx(api.tx.utility.batch(remarkTxs())))
  } catch (e) {
    const message = (e as Error).message
    if (/temporarily banned|not found on best chain/.test(message)) throw e
    onStage('signing', t('stage.batchFallback'))
    for (const tx of remarkTxs()) inclusions.push(await submitTx(tx))
  }

  const chainName = (await api.rpc.system.chain()).toString()
  return {
    version: 1,
    network: /mainnet/i.test(chainName) ? 'mainnet' : chainName,
    rootCid: prepared.rootCid,
    file: prepared.file,
    encryption: null,
    compression: null,
    uploader: { address: signer.address },
    nodes: prepared.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })),
    txs: inclusions,
    submittedAt: new Date().toISOString(),
  }
}
