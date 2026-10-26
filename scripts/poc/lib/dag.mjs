// IPLD packing and assembly (the only DSN-compatible encoding path: @autonomys/auto-dag-data).
// Pack: file → processFileToIPLDFormat → the blockstore holds encodeNode(node) bytes,
//       remark payload = compactAddLength(those bytes) (see auto-drive onchainPublisher).
// Assemble: same retrieval traversal as the official file-retriever — expand level by level in
//       link order; a node's IPLDNodeData.data is the file bytes; inlink nodes (no data) only
//       expand their links.

import { createReadStream } from 'node:fs'
import { MemoryBlockstore } from 'blockstore-core'
import {
  IPLDNodeData,
  MetadataType,
  blake3HashFromCid,
  cidOfNode,
  cidToString,
  decodeNode,
  encodeNode,
  processFileToIPLDFormat,
} from '@autonomys/auto-dag-data'
import { CID } from 'multiformats/cid'
import { compactAddLength } from '@polkadot/util'

// blake3 hash for indexer queries: bare hex (no 0x prefix, per the official dsnFetcher convention)
export const nodeHashHex = (cid) => Buffer.from(blake3HashFromCid(cid)).toString('hex')

// Pack a local file → { rootCid, nodes: [{cid, bytes}], totalSize }
export async function packFile(filePath, filename) {
  const stat = await import('node:fs/promises').then((m) => m.stat(filePath))
  const blockstore = new MemoryBlockstore()
  const stream = (async function* () {
    for await (const chunk of createReadStream(filePath)) yield chunk
  })()

  const rootCid = await processFileToIPLDFormat(
    blockstore,
    stream,
    BigInt(stat.size),
    filename ?? filePath.split('/').pop(),
  )

  // BFS from the root to collect the nodes that need publishing (the blockstore may contain
  // packing intermediates; publish only the closure reachable from the root — exactly the set of
  // nodes retrieval needs)
  const nodes = []
  const seen = new Set()
  const queue = [rootCid]
  while (queue.length > 0) {
    const cid = queue.shift()
    const key = cidToString(cid)
    if (seen.has(key)) continue
    seen.add(key)
    const bytes = await blockstore.get(cid)
    const node = decodeNode(bytes)
    nodes.push({ cid, bytes, node })
    for (const link of node.Links) queue.push(link.Hash)
  }
  return { rootCid, nodes, totalSize: stat.size }
}

// Assemble a file from a node table of "cid → encoded bytes" (getNode must be available synchronously).
// Returns { bytes, metadata }; throws when metadata.size does not match the actual byte count.
export function assemble(rootCid, getNodeBytes) {
  const getNode = (cid) => decodeNode(getNodeBytes(cid))
  const root = getNode(rootCid)
  const rootMeta = root.Data ? IPLDNodeData.decode(root.Data) : undefined
  if (!rootMeta) throw new Error('root node has no IPLD metadata')
  if (rootMeta.type !== MetadataType.File)
    throw new Error(`not a file root (type=${rootMeta.type})`)

  // Single-node file (< one chunk): the root itself carries all bytes (same as file-retriever)
  const parts = root.Links.length === 0 ? [Buffer.from(rootMeta.data ?? [])] : []

  let pending = root.Links.map((l) => l.Hash)
  while (pending.length > 0) {
    const next = []
    for (const linkCid of pending) {
      const node = getNode(linkCid)
      const meta = node.Data ? IPLDNodeData.decode(node.Data) : undefined
      if (meta?.data) {
        parts.push(Buffer.from(meta.data))
      } else {
        next.push(...node.Links.map((l) => l.Hash))
      }
    }
    pending = next
  }

  const bytes = Buffer.concat(parts)
  const expected = rootMeta.size != null ? Number(rootMeta.size) : null
  if (expected != null && bytes.length !== expected) {
    throw new Error(`assembled size ${bytes.length} != metadata.size ${expected}`)
  }
  return { bytes, metadata: rootMeta }
}

// system.remark(compactAddLength(encodedNode)) — same as onchainPublisher
export const makeRemarkPayload = (nodeBytes) => compactAddLength(nodeBytes)

// Lightweight helper for scan/retrieval: a remark payload (the node encoding after stripping the
// SCALE Bytes length prefix) → { cid, node }; returns null on parse failure (a remark is not
// necessarily dag-pb)
export function tryDecodeRemark(bytes) {
  try {
    const node = decodeNode(bytes)
    return { cid: cidOfNode(node), node }
  } catch {
    return null
  }
}

export { CID, cidOfNode, cidToString, decodeNode, encodeNode, IPLDNodeData, MetadataType }
