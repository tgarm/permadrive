// v1 → v2 registry migration: read v1 entries and re-register the ones missing from
// v2 at the normal fee (content addressing keeps manifestCid stable, so re-runs are
// idempotent; DuplicateEntry is treated as already registered).
// Usage: npm run migrate-v1 [ownerAddress]   (default = the address derived from CHAIN_MNEMONIC)

import { autoEvm, clients, deploymentV1, deploymentV2, ai3 } from './lib/chain.mjs'
import { REGISTRY_ABI } from '../../frontend/src/lib/registry-abi.ts'
import { REGISTRY_V1_ABI } from '../../frontend/src/lib/registry-abi-v1.ts'

const { address: signer, publicClient, walletClient } = clients()
const owner = (process.argv[2] ?? signer)
const V1 = deploymentV1().address
const V2 = deploymentV2().address

const v1Entries = await publicClient.readContract({ address: V1, abi: REGISTRY_V1_ABI, functionName: 'entries', args: [owner] })
const v2Entries = await publicClient.readContract({ address: V2, abi: REGISTRY_ABI, functionName: 'entries', args: [owner] })
const inV2 = new Set(v2Entries.map((e) => e.manifestCid))
console.log(`owner ${owner}`)
console.log(`v1 ${V1}: ${v1Entries.length} entries · v2 ${V2}: ${v2Entries.length} entries`)

let totalFee = 0n
for (const e of v1Entries) {
  if (inV2.has(e.manifestCid)) {
    console.log(`  = already in v2: ${e.name} (${e.manifestCid.slice(0, 20)}…)`)
    continue
  }
  const quote = await publicClient.readContract({
    address: V2, abi: REGISTRY_ABI, functionName: 'quote', args: [e.size],
  })
  console.log(`  → migrating: ${e.name} · ${e.size} B · fee ${ai3(quote)} (block #${e.height})`)
  const hash = await walletClient.writeContract({
    address: V2, abi: REGISTRY_ABI, functionName: 'register', account: walletClient.account,
    args: [e.manifestCid, e.height, e.name, e.size], value: quote,
  })
  const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (r.status !== 'success') throw new Error(`register ${e.name} failed (${r.status})`)
  totalFee += quote
  console.log(`    ✓ tx ${hash.slice(0, 18)}… · gas ${r.gasUsed}`)
}
console.log(totalFee > 0n ? `migration complete, total dev fee ${ai3(totalFee)} (treasury = ${deploymentV2().treasury})` : 'nothing to migrate')
