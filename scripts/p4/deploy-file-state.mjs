// P4 · Deploy FileState to Auto-EVM (2026-11-03 directory state layer: hide
// marks + generic file props) — two instances, no constructor args (no
// treasury/fee/permission surface, pure state contract):
//   main : auto-evm-mainnet-file-state
//   test : auto-evm-mainnet-file-state-test
// After deployment the on-chain code is compared byte-for-byte against the
// compiled artifact (no immutables, exact equality).
// Usage: node deploy-file-state.mjs [--force] — deployment spends real funds,
// confirm separately before running.
// Hardening: existing deployments.json entries are skipped by default (--force
// for explicit redeployment); the deploy tx hash is written to
// scripts/p4/out/deploy-file-state/<key>.txhash immediately after broadcast
// (before any waiting/recording); if interrupted, a re-run adopts the tx by
// hash and never broadcasts a second copy.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'

const INSTANCES = [
  { key: 'auto-evm-mainnet-file-state', adoptEnv: 'ADOPT_TX_HASH_MAIN' },
  { key: 'auto-evm-mainnet-file-state-test', adoptEnv: 'ADOPT_TX_HASH_TEST' },
]
const FORCE = process.argv.includes('--force')
const TXHASH_DIR = new URL('./out/deploy-file-state/', import.meta.url).pathname

const { address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/FileState.json', import.meta.url).pathname, 'utf8'))
const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}
const balance = await publicClient.getBalance({ address })
console.log('deployer :', address, '· balance', ai3(balance), '· chainId', await publicClient.getChainId())
if (balance === 0n) throw new Error('balance is 0')

const save = () => writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
const txhashFile = (key) => path.join(TXHASH_DIR, `${key}.txhash`)

for (const inst of INSTANCES) {
  if (deployments[inst.key] && !FORCE) {
    console.log(`[${inst.key}] deployment record already exists — skipping (--force for explicit redeployment):`, deployments[inst.key].address)
    continue
  }
  let txHash
  const pendingFile = txhashFile(inst.key)
  const pendingHash = existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8').trim() : ''
  if (pendingHash) {
    txHash = pendingHash
    console.log(`[${inst.key}] ⚠ found an unfinished deploy tx (interrupted in the broadcast/record window) — adopting by hash:`, txHash)
  } else if (process.env[inst.adoptEnv]) {
    txHash = process.env[inst.adoptEnv]
    console.log(`[${inst.key}] adopt tx:`, txHash)
  } else {
    txHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [], // FileState has no constructor args
    })
    mkdirSync(TXHASH_DIR, { recursive: true })
    writeFileSync(pendingFile, txHash + '\n')
    console.log(`[${inst.key}] deploy tx:`, txHash)
    console.log(`  ⚠ keep this hash; if this process is interrupted, re-running the script adopts it by hash (never deploys twice): ${pendingFile}`)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
  if (receipt.status !== 'success') {
    console.error(`[${inst.key}] deploy tx ${receipt.status} — tx hash saved at ${pendingFile}; investigate manually (do not simply re-run the deploy)`)
    throw new Error(`deploy tx ${receipt.status}`)
  }
  const contractAddress = receipt.contractAddress
  // no immutables — on-chain code must equal the compiled artifact exactly
  const onchainCode = await publicClient.getCode({ address: contractAddress })
  if (onchainCode !== artifact.deployedBytecode) throw new Error('deployed code does not match the compiled artifact — tx hash in console/' + pendingFile)
  console.log(`[${inst.key}] contract: ${contractAddress} · block ${receipt.blockNumber} · gas ${receipt.gasUsed} · code equal ✓`)
  deployments[inst.key] = {
    chainId: 870,
    address: contractAddress,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    deployer: address,
    deployedAt: new Date().toISOString(),
  }
  save()
  if (existsSync(pendingFile)) unlinkSync(pendingFile)
}
console.log('done.')
