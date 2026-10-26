// Feasibility verification script 1/3: public mainnet RPC availability + on-chain storage byte fee
// + recent-block extrinsic type census
// Usage: node rpc-check.mjs

import { ApiPromise, WsProvider } from '@polkadot/api'

const RPC = 'wss://rpc.mainnet.subspace.foundation/ws'

console.log(`connecting ${RPC} ...`)
const api = await ApiPromise.create({
  provider: new WsProvider(RPC),
  noInitWarn: true,
})

const head = await api.rpc.chain.getFinalizedHead()
const hdr = await api.rpc.chain.getHeader(head)
console.log('finalized height:', hdr.number.toNumber())

// On-chain storage byte fee (AutoDrive pricing = this value × multiplier)
const byteFee = (await api.query.transactionFees.transactionByteFee()).toJSON()
console.log('transactionFees.transactionByteFee:', JSON.stringify(byteFee))
const perMB = Number(byteFee.current) * 1e6 / 1e18
console.log(`→ direct publish cost ≈ ${perMB.toFixed(3)} AI3/MB`)

// remark's Bytes argument limit (runtime constant; the over-limit error message shows 10485760)
try {
  await api.tx.system.remark('0x' + '42'.repeat(64 * 1024)).toHex()
  console.log('64KiB remark constructible (on-chain limit is 10MiB, measured)')
} catch (e) {
  console.log('remark construction error:', e.message)
}

// Extrinsic type census of the last 30 blocks (rate-limit friendly: fetched sequentially, one block at a time)
const census = {}
for (let off = 0; off < 30; off++) {
  const h = hdr.number.toNumber() - off
  const bh = await api.rpc.chain.getBlockHash(h)
  const block = await api.rpc.chain.getBlock(bh)
  for (const ex of block.block.extrinsics) {
    const key = `${ex.method.section}.${ex.method.method}`
    census[key] = (census[key] ?? 0) + 1
  }
}
console.log(`\nlast 30 blocks extrinsic census:`)
for (const [k, v] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v}\t${k}`)
}
console.log('\n(sparse remarks on mainnet are normal — AutoDrive publishes infrequently; more common on taurus)')

await api.disconnect()
