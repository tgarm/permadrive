// P0 PoC · validates the retrieval path upfront (no test tokens needed): scan recent blocks for
// publishers such as AutoDrive, decode every system.remark in those blocks into nodes → find file
// DAGs complete enough to assemble → assemble → cross-check with the object-mapping indexer that
// these nodes have really been archived by the DSN.
// Note: mainnet publishing is active but bursty (locate blocks with batch-scan first; nobody
// publishes on chronos). This proves the "retrieve from chain + assemble" path works on real
// third-party data; bit-level identity is covered separately by retrieve.mjs (own files).
// Usage: node scan-live.mjs [--blocks N] [--at height]

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connectApi, walkBlocksBack, CHAIN_INDEXER } from './lib/chain.mjs'
import { IndexerClient } from './lib/indexer.mjs'
import { assemble, cidToString, decodeNode, nodeHashHex, IPLDNodeData, MetadataType } from './lib/dag.mjs'
import { stringToCid } from '@autonomys/auto-dag-data'

const argv = process.argv.slice(2)
const blockCount = Number(argv[argv.indexOf('--blocks') + 1] ?? 60)
const atHeight = argv.includes('--at') ? Number(argv[argv.indexOf('--at') + 1]) : null
const OUT_DIR = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT_DIR, { recursive: true })

const api = await connectApi()
// Note: finality on this chain can lag by days; recent activity lives on the best chain → walk back from the best head
const bestHeader = await api.rpc.chain.getHeader()
const finHash = atHeight
  ? await api.rpc.chain.getBlockHash(atHeight)
  : await api.rpc.chain.getBlockHash(bestHeader.number.toNumber())
const finHeader = await api.rpc.chain.getHeader(finHash)
console.log(`scan start: #${finHeader.number.toNumber()}${atHeight ? ' (historical)' : ' (best head; finality lags, see README)'}`)

// ---- Block scan: collect remark nodes + candidate file roots ----
const nodeBytes = new Map() // cidStr → bytes
const roots = [] // { cidStr, height }
let remarkTotal = 0
let dagRemarkTotal = 0
let scanned = 0

console.log(`\nscanning ${blockCount} blocks backwards (paced; ~${(blockCount * 1.7).toFixed(0)}s) …`)
const t0 = Date.now()
await walkBlocksBack(api, finHash, blockCount, async ({ height, found }) => {
  scanned++
  if (height % 10 === 0 || found.size > 0)
    console.log(`  #${height}: ${found.size} dag-pb remark(s) (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  for (const [cidStr, entry] of found) {
    if (!nodeBytes.has(cidStr)) nodeBytes.set(cidStr, entry.bytes)
    dagRemarkTotal++
    // File roots: IPLDNodeData.type === File with a name (AutoDrive also publishes metadata roots,
    // type=Metadata — excluded)
    try {
      const meta = entry.node.Data ? IPLDNodeData.decode(entry.node.Data) : null
      if (meta?.type === MetadataType.File) roots.push({ cidStr, height, meta })
    } catch {}
  }
})
console.log(`\nscanned ${scanned} blocks: ${nodeBytes.size} unique nodes, ${roots.length} file roots`)

// ---- Find complete DAGs (the whole root-reachable closure present among the collected nodes) ----
const getBytes = (cid) => nodeBytes.get(cidToString(cid))
const complete = []
for (const r of roots) {
  const closure = []
  const seen = new Set()
  let ok = true
  const queue = [r.cidStr]
  while (queue.length > 0 && ok) {
    const c = queue.shift()
    if (seen.has(c)) continue
    seen.add(c)
    const bytes = nodeBytes.get(c)
    if (!bytes) {
      ok = false
      break
    }
    closure.push(c)
    for (const link of decodeNode(bytes).Links) queue.push(cidToString(link.Hash))
  }
  if (ok) complete.push({ ...r, nodeCount: closure.length, closure })
}

complete.sort((a, b) => a.nodeCount - b.nodeCount)
console.log(`complete DAGs: ${complete.length}${complete.length ? ` (smallest ${complete[0].nodeCount} nodes, largest ${complete[complete.length - 1].nodeCount})` : ''}`)

// ---- Assemble the smallest complete file ----
let assembledInfo = null
for (const cand of complete) {
  try {
    const rootCid = stringToCid(cand.cidStr)
    const { bytes, metadata } = assemble(rootCid, getBytes)
    const name = (metadata.name ?? 'unnamed').replace(/[^\w.-]+/g, '_')
    const outPath = `${OUT_DIR}live-${cand.cidStr.slice(0, 12)}-${name}`
    writeFileSync(outPath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    console.log(`\nassembled file from block #${cand.height}:`)
    console.log(`  root CID : ${cand.cidStr}`)
    console.log(`  name     : ${metadata.name}`)
    console.log(`  size     : ${bytes.length} (metadata.size=${metadata.size})`)
    console.log(`  sha256   : ${sha256}`)
    console.log(`  saved    : ${outPath}`)
    assembledInfo = { ...cand, bytes, sha256, name, outPath }
    break
  } catch (e) {
    console.warn(`  candidate ${cand.cidStr} failed to assemble: ${e.message}`)
  }
}

await api.disconnect()

// ---- Indexer cross-check: all these nodes should already have object mappings ----
if (assembledInfo) {
  console.log(`\ncross-checking object mappings on indexer …`)
  const indexer = new IndexerClient(CHAIN_INDEXER)
  const hashes = assembledInfo.closure.map((c) => nodeHashHex(stringToCid(c)))
  const { found, pending } = await indexer.pollUntilIndexed(hashes, { timeoutMs: 60_000, intervalMs: 5000 })
  indexer.close()
  console.log(`  mapped: ${found.size}/${hashes.length}`)
  if (pending.length === 0) {
    const sample = [...found.entries()][0]
    console.log(`  ✓ DSN has archived all nodes (e.g. ${sample[0]} → pieceIndex=${sample[1].pieceIndex})`)
    console.log('\n════ Part A PASS: third-party file retrieved from chain + indexer-verified ════')
  } else {
    console.warn(`  ! pending (too fresh?): ${pending.join(', ')}`)
  }
} else {
  console.error('\nno complete file DAG found in scanned window; try --blocks 120')
  process.exit(1)
}
