// injected EVM wallet connection (the production path): window.ethereum (EIP-1193).
// Connect = eth_requestAccounts + making sure the wallet is on Auto-EVM (870):
// wallets without the chain return 4902 for wallet_switchEthereumChain, in
// which case fall back to wallet_addEthereumChain.

import type { EIP1193Provider } from 'viem'
import { AUTO_EVM_CHAIN_ID, walletAddChainParams } from '../evm'
import type { EvmSigner } from './types'

// window.ethereum has no standard lib.dom type (each wallet injects its own)
const getInjected = (): EIP1193Provider | undefined => (window as { ethereum?: EIP1193Provider }).ethereum

export function hasInjectedEvm(): boolean {
  return !!getInjected()
}

export async function connectInjectedEvm(): Promise<EvmSigner> {
  const eth = getInjected()
  if (!eth) throw new Error('no browser EVM wallet detected (MetaMask etc.)')
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts?.length) throw new Error('EVM wallet returned no accounts')
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: walletAddChainParams.chainId }] })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [walletAddChainParams] })
    } else throw e
  }
  const chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string
  if (Number.parseInt(chainIdHex, 16) !== AUTO_EVM_CHAIN_ID) {
    throw new Error(`wallet is not on Autonomys (chainId ${chainIdHex} ≠ 870) — switch manually in the wallet and retry`)
  }
  return { kind: 'injected', address: accounts[0], provider: eth, label: 'EVM browser wallet' }
}
