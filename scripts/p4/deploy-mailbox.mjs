// Deploy the Mailbox to Auto-EVM mainnet (chainId 870).
// No constructor args (announce/send are permissionless). After deployment the
// on-chain eth_getCode is compared byte-for-byte with the artifact (no
// immutables). If the tx landed but the script died, ADOPT_TX_HASH adopts it.
// Usage: npm run deploy-mailbox   or   ADOPT_TX_HASH=0x… npm run deploy-mailbox

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'

const { account, address, publicClient, walletClient } = clients()
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/Mailbox.json', import.meta.url).pathname, 'utf8'))

const balance = await publicClient.getBalance({ address })
console.log('deployer :', address)
console.log('balance  :', ai3(balance))
if (balance === 0n) throw new Error('balance is 0')

let txHash
if (process.env.ADOPT_TX_HASH) {
  txHash = process.env.ADOPT_TX_HASH
  console.log('adopt tx :', txHash, '(adopting an existing deployment — no double spend)')
} else {
  txHash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode })
  console.log('deploy tx:', txHash)
}

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
if (receipt.status !== 'success') throw new Error(`deploy tx ${receipt.status}`)
const contractAddress = receipt.contractAddress
if (!contractAddress) throw new Error('receipt has no contractAddress')

const onchainCode = await publicClient.getCode({ address: contractAddress })
console.log('contract :', contractAddress)
console.log('block    :', receipt.blockNumber, '· gas used', receipt.gasUsed)
console.log('code match:', onchainCode === artifact.deployedBytecode ? '✓ deployedBytecode identical (no immutables)' : '✗ mismatch')
if (onchainCode !== artifact.deployedBytecode) throw new Error('deployed code differs from the artifact')

const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}
deployments['auto-evm-mainnet-mailbox'] = {
  chainId: 870,
  address: contractAddress,
  txHash,
  blockNumber: receipt.blockNumber.toString(),
  deployer: address,
  deployedAt: new Date().toISOString(),
}
writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
console.log('→ contracts/deployments.json (auto-evm-mainnet-mailbox); verify in the browser:')
console.log(`  https://explorer.auto-evm.mainnet.autonomys.xyz/address/${contractAddress}`)
