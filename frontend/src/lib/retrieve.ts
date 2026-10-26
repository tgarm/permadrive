// Retrieval library: input is a manifest, provenance is irrelevant — behaves
// identically for self-published and third-party data (closed loop verified in
// The flow matches scripts/poc/retrieve.mjs: start from the blocks
// recorded in manifest.txs to fetch nodes, walk back toward parent blocks when
// nodes are missing (a utility.batch can straddle blocks), then assemble along
// the DAG once everything is collected.
// The indexer is not a prerequisite: while the mapping has not appeared yet,
// the data is already on chain and can be retrieved directly.

import type { ApiPromise } from '@polkadot/api'
import { extractRemarkNodes } from './chain'
import { assemble } from './dag'
import type { ManifestV1 } from './manifest'
import { sha256Hex } from './bytes'

export interface RetrieveResult {
  bytes: Uint8Array
  sha256: string
  metadata: { name?: string; size?: number | bigint }
  sha256Match: boolean
}

const MAX_PARENT_HOPS = 4

export async function retrieveFile(api: ApiPromise, manifest: ManifestV1): Promise<RetrieveResult> {
  const nodeBytesByCid = new Map<string, Uint8Array>()
  const wanted = new Set(manifest.nodes.map((n) => n.cid))
  for (const { blockHash } of manifest.txs) {
    let hash = blockHash
    for (let hop = 0; hop < MAX_PARENT_HOPS && wanted.size > nodeBytesByCid.size; hop++) {
      const { found, parentHash } = await extractRemarkNodes(api, hash)
      for (const [cid, bytes] of found) if (wanted.has(cid)) nodeBytesByCid.set(cid, bytes)
      hash = parentHash
    }
  }
  const missing = manifest.nodes.filter((n) => !nodeBytesByCid.has(n.cid))
  if (missing.length > 0) throw new Error(`${missing.length} node(s) not found on chain (within ${MAX_PARENT_HOPS} parent-block hops)`)

  const { bytes, metadata } = assemble(manifest.rootCid, (cid) => {
    const b = nodeBytesByCid.get(cid)
    if (!b) throw new Error(`missing node ${cid}`)
    return b
  })
  const sha256 = await sha256Hex(bytes)
  return { bytes, sha256, metadata, sha256Match: sha256 === manifest.file.sha256 }
}
