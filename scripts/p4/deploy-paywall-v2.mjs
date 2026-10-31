// Deploy PaywallV2 to Auto-EVM mainnet (chainId 870) — two instances:
//   main : deliveryTimeout 3 days / gracePeriod 3 days (production settings)
//   test : deliveryTimeout 5 minutes / gracePeriod 5 minutes (selftest walks the
//          full state machine; 3 days cannot be waited out on mainnet)
// Constructor: treasury = deployer; feeBps default 1000 (10%). Bytecode compared
// byte-for-byte after deployment (treasury/deliveryTimeout/gracePeriod immutables,
// each patched by AST mapping). ADOPT_TX_HASH_MAIN / ADOPT_TX_HASH_TEST adopt an
// existing deployment.
// Usage: node deploy-paywall-v2.mjs [--force] — deployment and on-chain disposition
// are a separate step: inventory the legacy instance (orders/credits) read-only
// first; the legacy contract has no admin migration capability.
// Hardening: skip when deployments.json already has the record (--force to redeploy
// explicitly) and write the record immediately after each instance — a first-instance-
// success/second-instance-failure rerun must not deploy the first one again.
// Broadcast/record window hardening: the deploy tx hash is written to
//   scripts/p4/out/deploy-paywall-v2/<key>.txhash immediately after broadcasting
//   (before any receipt wait) and echoed loudly on the console; the file is removed
//   once deployments.json is updated. If the script dies between "broadcast" and
//   "record": deployments.json has no entry but the txhash file exists → the next run
//   automatically takes over by hash (wait receipt → verify code → readback → record);
//   it never blindly re-deploys.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutablesMulti } from '../p3/lib/chain.mjs'

const DAY = 86400n
const INSTANCES = [
  { key: 'auto-evm-mainnet-paywall-v2', timeout: 3n * DAY, grace: 3n * DAY, adoptEnv: 'ADOPT_TX_HASH_MAIN' },
  { key: 'auto-evm-mainnet-paywall-v2-test', timeout: 5n * 60n, grace: 5n * 60n, adoptEnv: 'ADOPT_TX_HASH_TEST' },
]
const FORCE = process.argv.includes('--force')
const TXHASH_DIR = new URL('./out/deploy-paywall-v2/', import.meta.url).pathname

const { address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/PaywallV2.json', import.meta.url).pathname, 'utf8'))
const balance = await publicClient.getBalance({ address })
console.log('deployer :', address, '· balance', ai3(balance))
if (balance === 0n) throw new Error('balance is 0')

const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}

const save = () => writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
const txhashFile = (key) => path.join(TXHASH_DIR, `${key}.txhash`)

for (const inst of INSTANCES) {
  if (deployments[inst.key] && !FORCE) {
    console.log(`[${inst.key}] deployment record already exists — skipping (--force to redeploy explicitly):`, deployments[inst.key].address)
    continue
  }
  let txHash
  const pendingFile = txhashFile(inst.key)
  const pendingHash = existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8').trim() : ''
  if (pendingHash) {
    // broadcast/record window recovery: a previous run broadcast but never recorded —
    // take over by hash, never resend
    txHash = pendingHash
    console.log(`[${inst.key}] ⚠ found an unfinished deploy tx (interrupted between broadcast and record) — taking over by hash:`, txHash)
  } else if (process.env[inst.adoptEnv]) {
    txHash = process.env[inst.adoptEnv]
    console.log(`[${inst.key}] adopt tx:`, txHash)
  } else {
    txHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [address, inst.timeout, inst.grace],
    })
    mkdirSync(TXHASH_DIR, { recursive: true })
    writeFileSync(pendingFile, txHash + '\n') // persist the hash first, then wait for the receipt (window minimized)
    console.log(`[${inst.key}] deploy tx:`, txHash, `· timeout ${inst.timeout}s / grace ${inst.grace}s`)
    console.log(`  ⚠ keep this hash; if this process dies, rerunning the script takes over by that hash (never a duplicate deployment): ${pendingFile}`)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
  if (receipt.status !== 'success') {
    console.error(`[${inst.key}] deploy tx ${receipt.status} — the tx hash is saved at ${pendingFile}; verify manually before any action (do not just rerun the deployment)`)
    throw new Error(`deploy tx ${receipt.status}`)
  }
  const contractAddress = receipt.contractAddress
  // treasury / deliveryTimeout / gracePeriod: three immutables, each patched by AST mapping
  const expectedCode = patchImmutablesMulti(artifact, {
    treasury: address,
    deliveryTimeout: inst.timeout,
    gracePeriod: inst.grace,
  })
  const onchainCode = await publicClient.getCode({ address: contractAddress })
  if (onchainCode !== expectedCode) throw new Error('deployed bytecode differs from compiled artifact (after immutable patch) — tx hash in the console / ' + pendingFile)
  const [treasuryOn, feeBpsOn, dtOn, gpOn, orderCountOn] = await Promise.all(
    ['treasury', 'feeBps', 'deliveryTimeout', 'gracePeriod', 'orderCount'].map((f) =>
      publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: f }),
    ),
  )
  if (treasuryOn.toLowerCase() !== address.toLowerCase() || dtOn !== inst.timeout || gpOn !== inst.grace)
    throw new Error('readback parameters mismatch')
  console.log(`[${inst.key}] contract: ${contractAddress} · block ${receipt.blockNumber} · gas ${receipt.gasUsed} · feeBps ${feeBpsOn} · orderCount ${orderCountOn} · readback ✓`)
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
  save() // persist per instance immediately — a mid-run failure must not lose finished records
  if (existsSync(pendingFile)) unlinkSync(pendingFile) // record complete, window closed
}
console.log('→ contracts/deployments.json (paywall-v2 + paywall-v2-test)')
