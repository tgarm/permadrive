// Feasibility verification script 3/3: publish cost estimate (read-only, nothing goes on chain)
// Usage: node fee-estimate.mjs [bytes]   default 1048576 (1 MiB)
// Note: the public node's payment_queryInfo panics on large remarks, so a first-order byteFee
//       approximation is used; at 64KiB/node the base fee and tx wrapping overhead contribute <2%.

import { ApiPromise, WsProvider } from '@polkadot/api'

const RPC = 'wss://rpc.mainnet.subspace.foundation/ws'
const bytes = Number(process.argv[2] ?? 1048576)
const NODE_SIZE = 65536 // auto-dag-data DEFAULT_NODE_MAX_SIZE
const AI3_USD = 0.0042 // reference price 2026-10-24, display only

const api = await ApiPromise.create({
  provider: new WsProvider(RPC),
  noInitWarn: true,
})

const { current } = (await api.query.transactionFees.transactionByteFee()).toJSON()
const nodes = Math.ceil(bytes / NODE_SIZE)
const storageCost = Number(current) * bytes / 1e18

console.log(`payload:        ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MiB)`)
console.log(`IPLD nodes:     ${nodes} (64 KiB each, + ~${nodes} link nodes)`)
console.log(`storage fee:    ${storageCost.toFixed(4)} AI3 (byteFee=${current} shannons/B)`)
console.log(`≈ USD:          $${(storageCost * AI3_USD).toFixed(4)} @ AI3=$${AI3_USD}`)
console.log(`vs official buy: ${(storageCost * 2).toFixed(4)} AI3 (AutoDrive mainnet multiplier=2.0, and credits expire after 90 days)`)
console.log(`publish term:   permanent (DSN archive)`)

await api.disconnect()
