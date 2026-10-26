// IPLD packing and assembly (the only DSN-compatible encoding path: @autonomys/auto-dag-data).
// Packing: file → processFileToIPLDFormat → the blockstore holds encodeNode(node)
//       bytes; the remark payload = compactAddLength(those bytes) (same as the
//       auto-drive onchainPublisher).
// Assembly: identical to the official file-retriever's retrieval traversal —
//       expand layer by layer in link order; an IPLDNodeData.data node carries
//       file bytes, an inlink node (no data) only expands its links.

import {
  blake3HashFromCid,
  cidOfNode,
  cidToString,
  decodeNode,
  IPLDNodeData,
  MetadataType,
  processFileToIPLDFormat,
  stringToCid,
} from '@autonomys/auto-dag-data'
import { compactAddLength } from '@polkadot/util'
import { MemoryBlockstore } from 'blockstore-core'
import type { CID } from 'multiformats/cid'
import { toHex } from './bytes'

export interface PackedNode {
  cid: string
  blake3: string
  bytes: Uint8Array
}

export interface PackedFile {
  rootCid: string
  rootCidObj: CID
  nodes: PackedNode[] // BFS order, root first
  totalSize: number
}

// blake3 hash for indexer queries: bare hex (no 0x prefix, per the official dsnFetcher convention)
export const nodeHashHex = (cid: CID): string => toHex(new Uint8Array(blake3HashFromCid(cid)))

async function* streamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield value
  }
}

// Browser File → IPLD node closure (every node reachable from the root, i.e. the
// full set needed for publishing)
export async function packFile(file: File): Promise<PackedFile> {
  const blockstore = new MemoryBlockstore()
  const rootCid = await processFileToIPLDFormat(
    blockstore,
    streamToAsyncIterable(file.stream()) as AsyncIterable<Buffer>,
    BigInt(file.size),
    file.name,
  )

  // BFS collection (the blockstore may hold packing intermediates; publish only
  // the closure reachable from the root)
  const nodes: PackedNode[] = []
  const seen = new Set<string>()
  const queue: CID[] = [rootCid]
  while (queue.length > 0) {
    const cid = queue.shift()!
    const key = cidToString(cid)
    if (seen.has(key)) continue
    seen.add(key)
    const bytes = new Uint8Array(await blockstore.get(cid))
    const node = decodeNode(bytes)
    nodes.push({ cid: key, blake3: nodeHashHex(cid), bytes })
    for (const link of node.Links) queue.push(link.Hash)
  }
  return { rootCid: cidToString(rootCid), rootCidObj: rootCid, nodes, totalSize: file.size }
}

// Assemble a file from a node table of "cidString → encoded bytes".
// Returns { bytes, metadata }; throws when metadata.size disagrees with the
// actual byte count.
export function assemble(
  rootCid: string,
  getNodeBytes: (cid: string) => Uint8Array,
): { bytes: Uint8Array; metadata: { name?: string; size?: number | bigint } } {
  const getNode = (cid: string) => decodeNode(getNodeBytes(cid))
  const root = getNode(rootCid)
  const rootMeta = root.Data ? IPLDNodeData.decode(root.Data) : undefined
  if (!rootMeta) throw new Error('root node has no IPLD metadata')
  if (rootMeta.type !== MetadataType.File) throw new Error(`not a file root (type=${rootMeta.type})`)

  // Single-node file (< one chunk): the root itself carries all bytes
  const parts: Uint8Array[] = root.Links.length === 0 ? [new Uint8Array(rootMeta.data ?? [])] : []

  let pending = root.Links.map((l) => cidToString(l.Hash))
  while (pending.length > 0) {
    const next: string[] = []
    for (const linkCid of pending) {
      const node = getNode(linkCid)
      const meta = node.Data ? IPLDNodeData.decode(node.Data) : undefined
      if (meta?.data) {
        parts.push(new Uint8Array(meta.data))
      } else {
        next.push(...node.Links.map((l) => cidToString(l.Hash)))
      }
    }
    pending = next
  }

  const total = parts.reduce((a, p) => a + p.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    bytes.set(p, offset)
    offset += p.length
  }
  const expected = rootMeta.size != null ? Number(rootMeta.size) : null
  if (expected != null && bytes.length !== expected) {
    throw new Error(`assembled size ${bytes.length} != metadata.size ${expected}`)
  }
  return { bytes, metadata: rootMeta }
}

// system.remark(compactAddLength(encodedNode)) — identical to onchainPublisher
export const makeRemarkPayload = (nodeBytes: Uint8Array): Uint8Array => compactAddLength(nodeBytes)

// A remark payload segment (inner SCALE Bytes) → { cid, node }; null when parsing fails
export function tryDecodeRemark(bytes: Uint8Array): { cid: string } | null {
  try {
    const node = decodeNode(bytes)
    return { cid: cidToString(cidOfNode(node)) }
  } catch {
    return null
  }
}

export { stringToCid }
