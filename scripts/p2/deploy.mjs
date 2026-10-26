// P2 · Deploy FileRegistry to Auto-EVM mainnet (chainId 870).
// Signer = the EVM account derived at m/44'/60'/0'/0/0 from CHAIN_MNEMONIC (funded via xdm-transfer).
// After deploy: eth_getCode self-check against deployedBytecode; the record is appended to contracts/deployments.json (key auto-evm-mainnet).
// Usage: npm run deploy

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

const RPC = 'https://auto-evm.mainnet.autonomys.xyz/ws'
const ARTIFACT = new URL('../../contracts/out/FileRegistry.json', import.meta.url).pathname
// The deployment record is persisted into the repo (contracts/out/ is gitignored entirely; entries accumulate across networks)
const DEPLOYMENTS = new URL('../../contracts/deployments.json', import.meta.url).pathname

export const autoEvm = defineChain({
  id: 870,
  name: 'Autonomys',
  nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Auto EVM Explorer', url: 'https://explorer.auto-evm.mainnet.autonomys.xyz' } },
})

const mnemonic = (() => {
  if (process.env.CHAIN_MNEMONIC) return process.env.CHAIN_MNEMONIC
  const envFile = new URL('../poc/.env', import.meta.url).pathname
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/m)
    if (m) return m[1]
  }
  throw new Error('missing CHAIN_MNEMONIC in scripts/poc/.env')
})()

const account = mnemonicToAccount(mnemonic)
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
const publicClient = createPublicClient({ chain: autoEvm, transport: http(RPC) })
const walletClient = createWalletClient({ account, chain: autoEvm, transport: http(RPC) })

const balance = await publicClient.getBalance({ address: account.address })
console.log('deployer    :', account.address)
console.log('balance     :', (Number(balance) / 1e18).toFixed(6), 'AI3')
if (balance === 0n) throw new Error('balance is 0 — run npm run xdm-transfer first and wait ~10 minutes for arrival')

console.log('deploying  : letting the node estimate gas…')

const txHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [],
})
console.log('deploy tx   :', txHash)

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 })
if (receipt.status !== 'success') throw new Error(`deploy tx ${receipt.status}`)
const address = receipt.contractAddress
if (!address) throw new Error('receipt has no contractAddress')

const onchainCode = await publicClient.getCode({ address })
const expected = artifact.deployedBytecode
console.log('contract    :', address)
console.log('block       :', receipt.blockNumber, '· gas used', receipt.gasUsed)
console.log('code match  :', onchainCode === expected ? '✓ deployedBytecode identical' : `✗ mismatch (got ${onchainCode?.length} vs ${expected.length} hex chars)`)

if (onchainCode !== expected) throw new Error('deployed code does not match the compiled artifact')

const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {}
deployments['auto-evm-mainnet'] = {
  chainId: 870,
  address,
  txHash,
  blockNumber: receipt.blockNumber.toString(),
  deployer: account.address,
  deployedAt: new Date().toISOString(),
}
writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n')
console.log('→ contracts/deployments.json; verify in the explorer:', `https://explorer.auto-evm.mainnet.autonomys.xyz/address/${address}`)
