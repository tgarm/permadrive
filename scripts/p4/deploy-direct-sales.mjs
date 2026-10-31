// Deploy DirectSales to Auto-EVM mainnet (chainId 870; direct sales: pay-and-split
// with ratings, no escrow) — two instances:
//   main : production sales instance
//   test : acceptance-test instance (the acceptance runner's test listing lives
//          here, isolated from production)
// Constructor: treasury = deployer; platformBps default 1000 (10%). Bytecode compared
// byte-for-byte after deployment (single immutable treasury, patched by AST mapping).
// ADOPT_TX_HASH_MAIN / ADOPT_TX_HASH_TEST adopt an existing deployment.
// Usage: node deploy-direct-sales.mjs [--force] — deployment is real spend; execute
// it as a separate step after explicit confirmation.
// Hardening: skip when deployments.json already has the record (--force to redeploy
// explicitly) and write the record immediately after each instance.
// Broadcast/record window hardening: the deploy tx hash is written to
//   scripts/p4/out/deploy-direct-sales/<key>.txhash immediately after broadcasting
//   (before any receipt wait); an interrupted rerun takes over by hash and never
//   blindly re-broadcasts a second time.
//   Known residual window: the txhash file is written after deployContract returns;
//   if the node accepted the tx but the response was lost the file may be missing —
//   in that case verify manually via the deployer's nonce/tx history; never rerun
//   just because no local record exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutablesMulti } from '../p3/lib/chain.mjs'

// treasury can be set explicitly via the TREASURY env var (six-account test plan:
// the platform payout T must differ from deployer F when using separate roles —
// do not silently merge them); default = deployer (current single-operator setup)
const TREASURY = process.env.TREASURY && /^0x[0-9a-fA-F]{40}$/.test(process.env.TREASURY)
  ? process.env.TREASURY
  : null

const INSTANCES = [
  { key: 'auto-evm-mainnet-direct-sales', adoptEnv: 'ADOPT_TX_HASH_MAIN' },
  { key: 'auto-evm-mainnet-direct-sales-test', adoptEnv: 'ADOPT_TX_HASH_TEST' },
]
const FORCE = process.argv.includes('--force')
const TXHASH_DIR = new URL('./out/deploy-direct-sales/', import.meta.url).pathname

const { address, publicClient, walletClient } = clients()
const treasuryAddr = TREASURY ?? address
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/DirectSales.json', import.meta.url).pathname, 'utf8'))
const balance = await publicClient.getBalance({ address })
console.log('deployer :', address, '· balance', ai3(balance))
console.log('treasury :', treasuryAddr, TREASURY ? '(set explicitly via TREASURY env var)' : '(= deployer)')
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
      args: [treasuryAddr], // treasury (default = deployer; TREASURY env var sets T explicitly)
    })
    mkdirSync(TXHASH_DIR, { recursive: true })
    writeFileSync(pendingFile, txHash + '\n') // persist the hash first, then wait for the receipt (window minimized)
    console.log(`[${inst.key}] deploy tx:`, txHash)
    console.log(`  ⚠ keep this hash; if this process dies, rerunning the script takes over by that hash (never a duplicate deployment): ${pendingFile}`)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
  if (receipt.status !== 'success') {
    console.error(`[${inst.key}] deploy tx ${receipt.status} — the tx hash is saved at ${pendingFile}; verify manually before any action (do not just rerun the deployment)`)
    throw new Error(`deploy tx ${receipt.status}`)
  }
  const contractAddress = receipt.contractAddress
  // single immutable treasury: patched by AST mapping, then compared byte-for-byte with on-chain code
  const expectedCode = patchImmutablesMulti(artifact, { treasury: treasuryAddr })
  const onchainCode = await publicClient.getCode({ address: contractAddress })
  if (onchainCode !== expectedCode) throw new Error('deployed bytecode differs from compiled artifact (after immutable patch) — tx hash in the console / ' + pendingFile)
  const [treasuryOn, platformBpsOn, orderCountOn, listingCountOn] = await Promise.all(
    ['treasury', 'platformBps', 'orderCount', 'listingCount'].map((f) =>
      publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: f }),
    ),
  )
  if (treasuryOn.toLowerCase() !== treasuryAddr.toLowerCase() || platformBpsOn !== 1000 || orderCountOn !== 0n || listingCountOn !== 0n)
    throw new Error('readback parameters mismatch')
  console.log(`[${inst.key}] contract: ${contractAddress} · block ${receipt.blockNumber} · gas ${receipt.gasUsed} · platformBps ${platformBpsOn} · readback ✓`)
  deployments[inst.key] = {
    chainId: 870,
    address: contractAddress,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    deployer: address,
    treasury: treasuryAddr,
    platformBps: platformBpsOn,
    deployedAt: new Date().toISOString(),
  }
  save() // persist per instance immediately — a mid-run failure must not lose finished records
  if (existsSync(pendingFile)) unlinkSync(pendingFile) // record complete, window closed
}
console.log('done.')
