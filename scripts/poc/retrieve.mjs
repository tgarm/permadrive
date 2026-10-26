// P0 PoC · retrieve side: manifest → poll the indexer for object mappings → chain_getBlock
// extract remarks → decodeNode → assemble the DAG → compare sha256 with the original file.
// Usage: node retrieve.mjs [manifest.json] [--skip-indexer] [--timeout minutes]
//   With no manifest given, uses the newest one in out/.
// Key point: assembly uses only bytes recovered from the chain, never local packing artifacts —
// that is the whole point of the round trip.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connectApi, extractRemarkNodes } from './lib/chain.mjs'
import { IndexerClient } from './lib/indexer.mjs'
import { assemble, cidToString, nodeHashHex } from './lib/dag.mjs'
import { stringToCid } from '@autonomys/auto-dag-data'
import { sleep } from './lib/rpc.mjs'

const argv = process.argv.slice(2)
const skipIndexer = argv.includes('--skip-indexer')
const timeoutMin = Number(argv[argv.indexOf('--timeout') + 1] ?? 30)
const OUT_DIR = new URL('./out/', import.meta.url).pathname

let manifestPath = argv.find((a) => a.endsWith('.json'))
if (!manifestPath) {
  const latest = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('-manifest.json'))
    .sort()
    .pop()
  if (!latest) {
    console.error('no manifest found; run publish first')
    process.exit(1)
  }
  manifestPath = OUT_DIR + latest
}
if (!existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
console.log(`manifest: ${manifestPath}`)
console.log(`root CID: ${manifest.rootCid}, nodes: ${manifest.nodes.length}`)
const rootCid = stringToCid(manifest.rootCid)

// ---- Phase 1: indexer — wait for object mappings on every node (the signal that DSN archiving is done) ----
if (!skipIndexer) {
  console.log(`\n[1/2] polling indexer for object mappings (≤${timeoutMin} min) …`)
  const indexer = new IndexerClient(manifest.indexer)
  const hashes = manifest.nodes.map((n) => n.blake3)
  const started = Date.now()
  const { found, pending } = await indexer.pollUntilIndexed(hashes, {
    timeoutMs: timeoutMin * 60_000,
    onProgress: (got, total, round) =>
      console.log(`  round ${round}: ${got}/${total} mapped (${((Date.now() - started) / 1000).toFixed(0)}s)`),
  })
  indexer.close()
  if (pending.length > 0) {
    console.error(`  ✗ not indexed after ${timeoutMin} min: ${pending.join(', ')}`)
    process.exit(1)
  }
  const sample = [...found.entries()][0]
  console.log(`  ✓ all ${found.size} nodes mapped, e.g. ${sample[0]} → pieceIndex=${sample[1].pieceIndex} offset=${sample[1].pieceOffset}`)
} else {
  console.log('\n[1/2] indexer check skipped (--skip-indexer)')
}

// ---- Phase 2: on-chain retrieval ----
console.log(`\n[2/2] retrieving nodes from chain …`)
const api = await connectApi(manifest.rpc)

// Start from the blocks recorded in the manifest; if not all nodes are found in a block, walk back
// through parent blocks (a batch may span blocks)
const nodeBytesByCid = new Map()
const wanted = new Set(manifest.nodes.map((n) => n.cid))
for (const { blockHash, height } of manifest.txs) {
  let hash = blockHash
  for (let hop = 0; hop < 4 && wanted.size > nodeBytesByCid.size; hop++) {
    const { found, block } = await extractRemarkNodes(api, hash)
    console.log(`  block #${block.block.header.number.toNumber()}: ${found.size} dag-pb remark(s)`)
    for (const [cid, entry] of found) if (wanted.has(cid)) nodeBytesByCid.set(cid, entry.bytes)
    hash = block.block.header.parentHash
  }
}
const missing = manifest.nodes.filter((n) => !nodeBytesByCid.has(n.cid))
if (missing.length > 0) {
  console.error(`  ✗ missing from chain: ${missing.map((m) => m.cid).join(', ')}`)
  await api.disconnect()
  process.exit(1)
}
console.log(`  ✓ all ${nodeBytesByCid.size} nodes recovered from blocks`)

// ---- Assemble + compare ----
const { bytes, metadata } = assemble(rootCid, (cid) => nodeBytesByCid.get(cidToString(cid)))
const outPath = `${OUT_DIR}retrieved-${manifest.file.name}`
writeFileSync(outPath, bytes)
const sha256 = createHash('sha256').update(bytes).digest('hex')
console.log(`\nassembled: ${outPath} (${bytes.length} B, metadata name=${metadata.name})`)

await api.disconnect()
if (sha256 === manifest.file.sha256) {
  console.log('  sha256(original) =', manifest.file.sha256)
  console.log('  sha256(retrieved)=', sha256)
  console.log('\n════ P0 PoC PASS: round-trip bit-identical ════')
} else {
  console.error(`  ✗ sha256 mismatch!\n    original ${manifest.file.sha256}\n    retrieved ${sha256}`)
  process.exit(1)
}
