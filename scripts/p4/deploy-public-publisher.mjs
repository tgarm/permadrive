// Deploy PublicPublisher to Auto EVM mainnet (chainId 870) — two instances,
// each constructor argument welded to its own DirectSales (trust domain):
//   main : sales = auto-evm-mainnet-direct-sales (0x4321c47c...ee9b)
//   test : sales = auto-evm-mainnet-direct-sales-test (0xe2fb274a...4ade)
// After deployment the code is compared byte-for-byte (the single immutable
// `sales` patched via the AST) and sales()/DUST_PRICE/MAX_CID_LENGTH are read
// back against deployments.json (the deploy-time fake-sales exclusion).
// ADOPT_TX_HASH_MAIN / ADOPT_TX_HASH_TEST adopt an existing deployment.
// Usage: node deploy-public-publisher.mjs [--force] — deploying spends real
// funds; run it as a separate confirmed step. Hardened flow: an existing
// deployments.json entry skips by default (--force redeploys explicitly); the
// deploy tx hash is written to scripts/p4/out/deploy-public-publisher/<key>.txhash
// immediately after broadcast (before any waiting/recording); a re-run adopts
// the pending hash instead of ever re-broadcasting blindly.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutablesMulti } from '../p3/lib/chain.mjs'

const SALES_KEY = { main: 'auto-evm-mainnet-direct-sales', test: 'auto-evm-mainnet-direct-sales-test' }
const INSTANCES = [
  { key: 'auto-evm-mainnet-public-publisher', salesKey: SALES_KEY.main, adoptEnv: 'ADOPT_TX_HASH_MAIN' },
  { key: 'auto-evm-mainnet-public-publisher-test', salesKey: SALES_KEY.test, adoptEnv: 'ADOPT_TX_HASH_TEST' },
]
const FORCE = process.argv.includes('--force')
const TXHASH_DIR = new URL('./out/deploy-public-publisher/', import.meta.url).pathname

const { address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/PublicPublisher.json', import.meta.url).pathname, 'utf8'))
const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}
const balance = await publicClient.getBalance({ address })
console.log('deployer :', address, '· balance', ai3(balance))
if (balance === 0n) throw new Error('deployer balance is 0')

const save = () => writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
const txhashFile = (key) => path.join(TXHASH_DIR, `${key}.txhash`)

for (const inst of INSTANCES) {
  if (deployments[inst.key] && !FORCE) {
    console.log(`[${inst.key}] deployment record already exists — skipping (use --force to redeploy):`, deployments[inst.key].address)
    continue
  }
  const sales = deployments[inst.salesKey]
  if (!sales) throw new Error(`deployments.json is missing ${inst.salesKey} — the trust domain must point at the real DirectSales`)
  let txHash
  const pendingFile = txhashFile(inst.key)
  const pendingHash = existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8').trim() : ''
  if (pendingHash) {
    txHash = pendingHash
    console.log(`[${inst.key}] WARNING: unfinished deploy tx found (broadcast/record window interrupted) — adopting by hash:`, txHash)
  } else if (process.env[inst.adoptEnv]) {
    txHash = process.env[inst.adoptEnv]
    console.log(`[${inst.key}] adopt tx:`, txHash)
  } else {
    txHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [sales.address], // immutable sales: main->main / test->test (trust domain)
    })
    mkdirSync(TXHASH_DIR, { recursive: true })
    writeFileSync(pendingFile, txHash + '\n')
    console.log(`[${inst.key}] deploy tx:`, txHash)
    console.log(`  WARNING: keep this hash; if this process is interrupted, re-running adopts it instead of redeploying: ${pendingFile}`)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
  if (receipt.status !== 'success') {
    console.error(`[${inst.key}] deploy tx ${receipt.status} — the hash is saved at ${pendingFile}; investigate manually (do not just re-run the deploy)`)
    throw new Error(`deploy tx ${receipt.status}`)
  }
  const contractAddress = receipt.contractAddress
  const expectedCode = patchImmutablesMulti(artifact, { sales: sales.address })
  const onchainCode = await publicClient.getCode({ address: contractAddress })
  if (onchainCode !== expectedCode) throw new Error('deployed code differs from the artifact (after the immutable patch) — see the tx hash above / ' + pendingFile)
  const [salesOn, dustOn, maxCidOn] = await Promise.all(
    ['sales', 'DUST_PRICE', 'MAX_CID_LENGTH'].map((f) =>
      publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: f }),
    ),
  )
  if (salesOn.toLowerCase() !== sales.address.toLowerCase() || dustOn !== 1n || maxCidOn !== 128n)
    throw new Error('readback mismatch (sales/DUST_PRICE/MAX_CID_LENGTH)')
  console.log(`[${inst.key}] contract: ${contractAddress} · block ${receipt.blockNumber} · gas ${receipt.gasUsed} · sales=${salesOn} · readback OK`)
  deployments[inst.key] = {
    chainId: 870,
    address: contractAddress,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    deployer: address,
    sales: sales.address,
    deployedAt: new Date().toISOString(),
  }
  save() // persist per instance — an interrupted run never loses completed records
  if (existsSync(pendingFile)) unlinkSync(pendingFile) // the window closes
}
console.log('done.')
