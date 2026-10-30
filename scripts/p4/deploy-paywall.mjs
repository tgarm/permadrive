// Deploy the Paywall to Auto-EVM mainnet (chainId 870) — two instances:
//   main : deliveryTimeout 3 days / gracePeriod 3 days (production values)
//   test : deliveryTimeout 5 minutes / gracePeriod 5 minutes (lets the
//          selftest walk the full state machine — mainnet cannot wait 3 days)
// Constructor: treasury = deployer; feeBps defaults to 1000 (10%). The on-chain
// code is compared byte-for-byte (3 immutables, patched from the AST).
// ADOPT_TX_HASH_MAIN / ADOPT_TX_HASH_TEST adopt existing deployments.
// Usage: npm run deploy-paywall

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutablesMulti } from '../p3/lib/chain.mjs'

const DAY = 86400n
const INSTANCES = [
  { key: 'auto-evm-mainnet-paywall', timeout: 3n * DAY, grace: 3n * DAY, adoptEnv: 'ADOPT_TX_HASH_MAIN' },
  { key: 'auto-evm-mainnet-paywall-test', timeout: 5n * 60n, grace: 5n * 60n, adoptEnv: 'ADOPT_TX_HASH_TEST' },
]

const { address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/Paywall.json', import.meta.url).pathname, 'utf8'))
const balance = await publicClient.getBalance({ address })
console.log('deployer :', address, '· balance', ai3(balance))
if (balance === 0n) throw new Error('balance is 0')

const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}

for (const inst of INSTANCES) {
  let txHash
  if (process.env[inst.adoptEnv]) {
    txHash = process.env[inst.adoptEnv]
    console.log(`[${inst.key}] adopt tx:`, txHash)
  } else {
    txHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [address, inst.timeout, inst.grace],
    })
    console.log(`[${inst.key}] deploy tx:`, txHash, `· timeout ${inst.timeout}s / grace ${inst.grace}s`)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
  if (receipt.status !== 'success') throw new Error(`deploy tx ${receipt.status}`)
  const contractAddress = receipt.contractAddress
  // the three immutables (treasury / deliveryTimeout / gracePeriod), each patched via the AST mapping
  const expectedCode = patchImmutablesMulti(artifact, {
    treasury: address,
    deliveryTimeout: inst.timeout,
    gracePeriod: inst.grace,
  })
  const onchainCode = await publicClient.getCode({ address: contractAddress })
  if (onchainCode !== expectedCode) throw new Error('deployed code differs from the artifact (after the immutable patch)')
  const [treasuryOn, feeBpsOn, dtOn, gpOn] = await Promise.all(
    ['treasury', 'feeBps', 'deliveryTimeout', 'gracePeriod'].map((f) =>
      publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: f }),
    ),
  )
  if (treasuryOn.toLowerCase() !== address.toLowerCase() || dtOn !== inst.timeout || gpOn !== inst.grace)
    throw new Error('readback values do not match expectations')
  console.log(`[${inst.key}] contract: ${contractAddress} · block ${receipt.blockNumber} · gas ${receipt.gasUsed} · feeBps ${feeBpsOn} · readback ✓`)
  deployments[inst.key] = {
    chainId: 870,
    address: contractAddress,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    deployer: address,
    treasury: address,
    deliveryTimeout: inst.timeout.toString(),
    gracePeriod: inst.grace.toString(),
    deployedAt: new Date().toISOString(),
  }
}

writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
console.log('→ contracts/deployments.json (paywall + paywall-test)')
