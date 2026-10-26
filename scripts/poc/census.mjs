// Decoded block census: extrinsic type distribution over the most recent N blocks + system.remark details
// Usage: node census.mjs [block count] [start height (defaults to finalized head)]
import { connectApi } from './lib/chain.mjs'

const count = Number(process.argv[2] ?? 30)
const startArg = process.argv[3] ? Number(process.argv[3]) : null

const api = await connectApi()
const headHash = await api.rpc.chain.getFinalizedHead()
const headHeader = await api.rpc.chain.getHeader(headHash)
const start = startArg ?? headHeader.number.toNumber()
const targetHash = await api.rpc.chain.getBlockHash(start)

const census = {}
let remarks = []
let hash = targetHash
for (let i = 0; i < count; i++) {
  const block = await api.rpc.chain.getBlock(hash)
  const height = block.block.header.number.toNumber()
  for (const ex of block.block.extrinsics) {
    const key = `${ex.method.section}.${ex.method.method}`
    census[key] = (census[key] ?? 0) + 1
    if (ex.method.section === 'system' && ex.method.method === 'remark')
      remarks.push({ height, signer: ex.signer.toString(), bytes: ex.args[0]?.length })
  }
  hash = block.block.header.parentHash
}
console.log(`census of ${count} blocks from #${start}:`)
for (const [k, v] of Object.entries(census).sort((a, b) => b[1] - a[1]))
  console.log(`  ${v}\t${k}`)
console.log(`remarks: ${remarks.length}`)
if (remarks.length > 0)
  console.log('sample:', JSON.stringify(remarks.slice(0, 5)))
await api.disconnect()
