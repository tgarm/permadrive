// P3 · Deploy FileRegistryV2 to Auto-EVM mainnet (chainId 870).
// Constructor args: treasury = deployer (zero-sum during development; can switch to a
//                   multisig/new address for production),
//                   feePerByte = 105,245,676,421 (≈5% × consensus transactionByteFee),
//                   minFee = 1e16 (0.01 AI3).
// After deploy, eth_getCode is compared against the compiled artifact — v2 contains an
// immutable (treasury) and deployedBytecode holds a zero placeholder at that position,
// so the immutableReferences patch with the constructor args must be applied first.
// If the tx landed on chain but the script was interrupted, ADOPT_TX_HASH=0x… npm run deploy
// adopts the existing deployment (no repeated spend).
// Usage: npm run deploy   or   ADOPT_TX_HASH=0x… npm run deploy

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutables } from './lib/chain.mjs'

// ≈5% × 2,104,913,528,421 shannon/byte (×0.05 after converting to wei)
const FEE_PER_BYTE = 105_245_676_421n
const MIN_FEE = 1n * 10n ** 16n // 0.01 AI3

const { account, address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/FileRegistryV2.json', import.meta.url).pathname, 'utf8'))
const expectedCode = patchImmutables(artifact, address)

const balance = await publicClient.getBalance({ address })
console.log('deployer :', address)
console.log('balance  :', ai3(balance))
if (balance === 0n) throw new Error('balance is 0')

let txHash
if (process.env.ADOPT_TX_HASH) {
  txHash = process.env.ADOPT_TX_HASH
  console.log('adopt tx :', txHash, '(adopting an existing deployment, no repeated spend)')
} else {
  console.log('args     : feePerByte =', FEE_PER_BYTE, '· minFee =', ai3(MIN_FEE), '· treasury =', address)
  txHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [address, FEE_PER_BYTE, MIN_FEE],
  })
  console.log('deploy tx:', txHash)
}

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
if (receipt.status !== 'success') throw new Error(`deploy tx ${receipt.status}`)
const contractAddress = receipt.contractAddress
if (!contractAddress) throw new Error('receipt has no contractAddress')

const onchainCode = await publicClient.getCode({ address: contractAddress })
console.log('contract :', contractAddress)
console.log('block    :', receipt.blockNumber, '· gas used', receipt.gasUsed)
console.log('code match:', onchainCode === expectedCode ? '✓ deployedBytecode identical (after immutable patch)' : '✗ mismatch')
if (onchainCode !== expectedCode) throw new Error('deployed code does not match the compiled artifact')

// Self-check: read back the constructor args
const [treasuryOnchain, fpb, mf] = await Promise.all([
  publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: 'treasury' }),
  publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: 'feePerByte' }),
  publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: 'minFee' }),
])
console.log('readback : treasury', treasuryOnchain, '· feePerByte', fpb, '· minFee', ai3(mf))
if (treasuryOnchain.toLowerCase() !== address.toLowerCase() || fpb !== FEE_PER_BYTE || mf !== MIN_FEE) {
  throw new Error('readback args do not match expectations')
}

const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}
deployments['auto-evm-mainnet-v2'] = {
  chainId: 870,
  address: contractAddress,
  txHash,
  blockNumber: receipt.blockNumber.toString(),
  deployer: address,
  treasury: address,
  feePerByte: FEE_PER_BYTE.toString(),
  minFee: MIN_FEE.toString(),
  deployedAt: new Date().toISOString(),
}
writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
console.log('→ contracts/deployments.json (auto-evm-mainnet-v2); verify in the explorer:')
console.log(`  https://explorer.auto-evm.mainnet.autonomys.xyz/address/${contractAddress}`)
