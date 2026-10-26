// P2 · Registry helper operations (Node side; post-deploy self-check / acceptance aid / debugging):
//   node registry.mjs entries <address>
//   node registry.mjs register <manifestCid> <height> <name> <size>
//   node registry.mjs remove <manifestCid>
//   node registry.mjs code            (compares against this repo's compiled artifact)
// Reads go over the public RPC; writes are locally signed with the EVM account derived from CHAIN_MNEMONIC.

import { readFileSync, existsSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
// p2 scripts operate on the v1 contract (the auto-evm-mainnet key); the v1 ABI is frozen in registry-abi-v1.ts
import { REGISTRY_V1_ABI as REGISTRY_ABI } from '../../frontend/src/lib/registry-abi-v1.ts'

const RPC = 'https://auto-evm.mainnet.autonomys.xyz/ws'
const DEPLOYMENTS = new URL('../../contracts/deployments.json', import.meta.url).pathname
const ARTIFACT = new URL('../../contracts/out/FileRegistry.json', import.meta.url).pathname

const autoEvm = defineChain({
  id: 870,
  name: 'Autonomys',
  nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

if (!existsSync(DEPLOYMENTS)) throw new Error('missing contracts/deployments.json — run npm run deploy first')
const { address: REGISTRY } = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))['auto-evm-mainnet']
const publicClient = createPublicClient({ chain: autoEvm, transport: http(RPC) })

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'entries') {
  const entries = await publicClient.readContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'entries',
    args: [args[0]],
  })
  console.log(JSON.stringify(entries, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
} else if (cmd === 'code') {
  const code = await publicClient.getCode({ address: REGISTRY })
  const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/FileRegistry.json', import.meta.url).pathname, 'utf8'))
  console.log('code match:', code === artifact.deployedBytecode ? '✓' : '✗')
} else if (cmd === 'register' || cmd === 'remove') {
  const mnemonic = (() => {
    if (process.env.CHAIN_MNEMONIC) return process.env.CHAIN_MNEMONIC
    const envFile = new URL('../poc/.env', import.meta.url).pathname
    const m = readFileSync(envFile, 'utf8').match(/^\s*CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/m)
    if (!m) throw new Error('missing CHAIN_MNEMONIC')
    return m[1]
  })()
  const account = mnemonicToAccount(mnemonic)
  const wallet = createWalletClient({ account, chain: autoEvm, transport: http(RPC) })
  console.log('signer:', account.address)
  const balance = await publicClient.getBalance({ address: account.address })
  console.log('balance:', (Number(balance) / 1e18).toFixed(6), 'AI3')

  const hash =
    cmd === 'register'
      ? await wallet.writeContract({
          address: REGISTRY,
          abi: REGISTRY_ABI,
          functionName: 'register',
          account,
          args: [args[0], Number(args[1]), args[2], BigInt(args[3])],
        })
      : await wallet.writeContract({
          address: REGISTRY,
          abi: REGISTRY_ABI,
          functionName: 'remove',
          account,
          args: [args[0]],
        })
  console.log('tx:', hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  console.log('status:', receipt.status, 'block:', receipt.blockNumber, 'gas:', receipt.gasUsed)
} else {
  console.log('usage: registry.mjs entries <address> | register <cid> <height> <name> <size> | remove <cid> | code')
}
