// Feasibility verification script 2/3: public object-mapping indexer response test
// Usage: node indexer-check.mjs [cid]
// Notes: get_object_mappings's hashes are the bare hex (no 0x prefix) of the CID multihash digest
//       (blake3) — confirmed 2026-10-25, with a 0x prefix every hash simply comes back not found.
//       The default CID is a file DAG root whose nodes are all present in the index.

import WebSocket from 'ws'
import { CID } from 'multiformats/cid'

const INDEXER = 'wss://indexer.mainnet.autonomys.xyz/ws'
const cidStr = process.argv[2] ?? 'bafkr6id4cndgymlit4kmxpgxovv4o5ij33zkmgg2jugowhtw4jhgmqfvzi'

const cid = CID.parse(cidStr)
const hashHex = Buffer.from(cid.multihash.digest).toString('hex')
console.log(`cid:     ${cidStr}`)
console.log(`blake3:  ${hashHex} (bare hex)`)

const ws = new WebSocket(INDEXER)
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error('timeout 20s')) }, 20000)
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'get_object_mappings',
      params: { hashes: [hashHex] },
    }))
  })
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString())
    if (msg.id === 1) { clearTimeout(timer); ws.close(); resolve(msg) }
  })
  ws.on('error', (e) => { clearTimeout(timer); reject(e) })
})

if (reply.error) {
  console.log(`indexer reply (error): ${reply.error.message}`)
  console.log('→ the API works; this hash is just not indexed (expected when passing a never-published CID)')
} else {
  console.log('indexer reply (mapping):', JSON.stringify(reply.result))
  console.log('→ [hash, pieceIndex, pieceOffset] (no blockNumber; locating the block requires the publisher\'s record or a block scan)')
}
