// Batch block scan: uses JSON-RPC batch (verified supported by chronos nodes) to fetch a batch of
// blocks per POST, walking back from the best head (or a --at height), counting/locating dag-pb
// nodes inside system.remark.
// Strips SCALE manually (callIndex 0x0000/0x0001 + compact Bytes prefix); no polkadot api needed.
// Usage: node batch-scan.mjs [total blocks] [batch size] [--at start height]
import { RawRpc } from './lib/rpc.mjs'
import { tryDecodeRemark, IPLDNodeData } from './lib/dag.mjs'

const total = Number(process.argv[2] ?? 30000)
const batchSize = Number(process.argv[3] ?? 25)
const atIdx = process.argv.indexOf('--at')
const atHeight = atIdx >= 0 ? Number(process.argv[atIdx + 1]) : null
const rpc = new RawRpc(process.env.CHAIN_RPC ?? 'https://rpc.chronos.autonomys.xyz/ws', {
  minIntervalMs: Number(process.env.BATCH_MIN_INTERVAL_MS ?? 1400),
  maxRetries: 8,
})

// SCALE compact prefix → {len, off}. The mode lives in the low 2 bits of the first byte:
// 0b00 single byte; 0b01 two bytes; 0b10 four bytes (enough for nodes ≤64KiB; 0b11 big-integer mode not applicable)
const compactPrefix = (buf, start) => {
  const first = buf[start]
  const mode = first & 3
  if (mode === 0) return { len: first >> 2, off: 1 }
  if (mode === 1) return { len: (first >> 2) | (buf[start + 1] << 6), off: 2 }
  if (mode === 2)
    return {
      len: (first >> 2) | (buf[start + 1] << 6) | (buf[start + 2] << 14) | (buf[start + 3] << 22),
      off: 4,
    }
  throw new Error('compact big-integer mode not expected for IPLD nodes')
}

const head = await rpc.call('chain_getBlockHash', atHeight ? [atHeight] : [])
let frontier = head
let scanned = 0
let remarkNodes = 0
const hits = []
const t0 = Date.now()

while (scanned < total) {
  const n = Math.min(batchSize, total - scanned)
  // Walk back by height: expanding the parent chain one block at a time is too slow, so use two
  // batches: hash-by-height + getBlock. frontier is the oldest block of the previous batch
  // (already scanned); every batch after the first starts at the height just below it.
  const frontierHeight = (await rpc.call('chain_getHeader', [frontier])).number
  const skip = scanned === 0 ? 0 : 1
  const topHeight = frontierHeight - skip
  const heightRequests = []
  for (let i = 0; i < n; i++)
    heightRequests.push({ jsonrpc: '2.0', id: i + 1, method: 'chain_getBlockHash', params: [topHeight - i] })
  const hashReplies = await rpc.callBatch(heightRequests)
  const blockRequests = hashReplies.map((r, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'chain_getBlock', params: [r.result] }))
  const blocks = await rpc.callBatch(blockRequests)

  for (const reply of blocks) {
    const blk = reply.result.block
    const height = parseInt(blk.header.number, 16)
    let count = 0
    const types = {}
    for (const exHex of blk.extrinsics) {
      const buf = Buffer.from(exHex.slice(2), 'hex')
      if (buf.length < 3) continue
      // callIndex belt-and-braces: measured on Autonomys, system.remark=0x0000 (chronos), while
      // regular Substrate uses 0x0001; try both patterns and filter false positives by
      // "compact consuming exactly the remaining bytes + decodable dag-pb"
      const candidates = []
      const pushCandidate = (o) => {
        for (const ci of [
          [0x00, 0x00],
          [0x00, 0x01],
        ]) {
          if (buf[o] !== ci[0] || buf[o + 1] !== ci[1]) continue
          try {
            const { len, off } = compactPrefix(buf, o + 2)
            if (o + 2 + off + len === buf.length) candidates.push(o)
          } catch {}
        }
      }
      // Unsigned extrinsic: [version 1B][call]; the signed variant has a ~100B signature area before
      // the call → scan offsets 1..300
      for (let o = 1; o < Math.min(buf.length - 3, 300); o++) pushCandidate(o)
      for (const o of candidates) {
        try {
          const { len, off } = compactPrefix(buf, o + 2)
          const decoded = tryDecodeRemark(buf.subarray(o + 2 + off, o + 2 + off + len))
          if (!decoded) continue
          const meta = decoded.node.Data ? IPLDNodeData.decode(decoded.node.Data) : null
          count++
          remarkNodes++
          const t = meta?.type ?? 'unknown'
          types[t] = (types[t] ?? 0) + 1
        } catch {}
      }
    }
    if (count > 0) hits.push({ height, count, types })
  }
  scanned += n
  frontier = hashReplies[hashReplies.length - 1].result // next batch's starting point (oldest block hash)
  if (scanned % 250 < batchSize)
    console.log(`  … #${topHeight}: ${scanned} scanned, ${remarkNodes} nodes, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (remarkNodes > 20000) break
}

console.log(`\nscanned ${scanned} blocks in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log(`dag-pb remark nodes: ${remarkNodes}, blocks with hits: ${hits.length}`)
for (const h of hits.slice(-50)) console.log(`  #${h.height}: ${h.count} ${JSON.stringify(h.types)}`)
