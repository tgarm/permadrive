// Shared on-chain setup: Auto-EVM mainnet (chainId 870), deployments keys, signer loading.
// Known pitfall: this RPC occasionally fails the TLS handshake; just re-run the script
// (the viem http transport has no built-in retry).

import { readFileSync, existsSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

export const RPC = 'https://auto-evm.mainnet.autonomys.xyz/ws'
export const DEPLOYMENTS = new URL('../../../contracts/deployments.json', import.meta.url).pathname

export const autoEvm = defineChain({
  id: 870,
  name: 'Autonomys',
  nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Auto EVM Explorer', url: 'https://explorer.auto-evm.mainnet.autonomys.xyz' } },
})

export function deploymentV2() {
  if (!existsSync(DEPLOYMENTS)) throw new Error('missing contracts/deployments.json — run npm run deploy first')
  const all = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const d = all['auto-evm-mainnet-v2']
  if (!d) throw new Error('deployments.json has no auto-evm-mainnet-v2 entry — run npm run deploy first')
  return d
}

export function deploymentV1() {
  if (!existsSync(DEPLOYMENTS)) throw new Error('missing contracts/deployments.json')
  const all = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const d = all['auto-evm-mainnet']
  if (!d) throw new Error('deployments.json has no auto-evm-mainnet (v1) entry')
  return d
}

export function loadMnemonic() {
  if (process.env.CHAIN_MNEMONIC) return process.env.CHAIN_MNEMONIC
  const envFile = new URL('../../poc/.env', import.meta.url).pathname
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/m)
    if (m) return m[1]
  }
  throw new Error('missing CHAIN_MNEMONIC in scripts/poc/.env')
}

export function clients() {
  const account = mnemonicToAccount(loadMnemonic())
  return {
    account,
    address: account.address,
    publicClient: createPublicClient({ chain: autoEvm, transport: http(RPC) }),
    walletClient: createWalletClient({ account, chain: autoEvm, transport: http(RPC) }),
  }
}

export const ai3 = (wei) => (Number(wei) / 1e18).toFixed(6) + ' AI3'

// Immutable positions in deployedBytecode are zero placeholders, filled with the
// constructor args at construction time. solc's immutableReferences are keyed by AST id
// (not variable name) and may reference multiple sites; this contract has a single
// immutable (treasury), so the same value is written to every slot. value: '0xaddress' or bigint.
// If a future contract gains a second immutable, this function refuses and must be
// extended per AST id.
export function patchImmutables(artifact, value) {
  const refsAll = Object.entries(artifact.immutableReferences ?? {})
  if (refsAll.length === 0) return artifact.deployedBytecode
  if (refsAll.length > 1) throw new Error(`patchImmutables supports a single immutable only, found ${refsAll.length}`)
  let hex = artifact.deployedBytecode.replace(/^0x/, '').toLowerCase()
  for (const [, refs] of refsAll) {
    const hexVal =
      typeof value === 'bigint'
        ? value.toString(16).padStart(refs[0].length * 2, '0')
        : value.replace(/^0x/, '').toLowerCase().padStart(refs[0].length * 2, '0')
    for (const { start, length } of refs) {
      if (hexVal.length !== length * 2) throw new Error(`immutable value length ${hexVal.length / 2}B != slot ${length}B`)
      hex = hex.slice(0, start * 2) + hexVal + hex.slice((start + length) * 2)
    }
  }
  return '0x' + hex
}
