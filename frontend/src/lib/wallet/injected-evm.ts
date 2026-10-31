// injected EVM wallet discovery and connection (the production path).
// Discovery: EIP-6963 multi-wallet announcements (MetaMask / Rabby etc. each
// report their own provider when several are installed); if nothing announces
// within the timeout, fall back to legacy window.ethereum (a .providers array
// when several wallets coexist, with brand flags used to guess the name).
// Connect = eth_requestAccounts + making sure the wallet is on Auto-EVM (870):
// wallets without the chain return 4902 for wallet_switchEthereumChain, in
// which case fall back to wallet_addEthereumChain.

import type { EIP1193Provider } from 'viem'
import { AUTO_EVM_CHAIN_ID, walletAddChainParams } from '../evm.ts'
import type { EvmSigner } from './types.ts'
import { t } from '../../i18n/core.ts'

// wallet metadata announced via EIP-6963 (info.icon is a dataURI; this app
// uses text-only buttons and ignores it)
interface Eip6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface DiscoveredEvmWallet {
  /** display name (a proper noun such as MetaMask; same convention as the Substrate-side w.title) */
  name: string
  /** stable identifier (written by the lib layer; the brand name as-is, or 'injected' for legacy wallets of unknown brand — WalletBar maps it to a display name) */
  label: string
  provider: EIP1193Provider
}

// window.ethereum has no standard lib.dom type (each wallet injects its own)
const getInjected = (): (EIP1193Provider & { providers?: EIP1193Provider[] }) | undefined =>
  (window as { ethereum?: EIP1193Provider & { providers?: EIP1193Provider[] } }).ethereum

// legacy brand flag → display name. Order is priority: wallet-specific flags
// first, isMetaMask last — many wallets set it for compatibility (Rabby and
// others set both).
const BRAND_FLAGS: Array<[string, string]> = [
  ['isRabby', 'Rabby'],
  ['isCoinbaseWallet', 'Coinbase Wallet'],
  ['isPhantom', 'Phantom'],
  ['isTrust', 'Trust Wallet'],
  ['isBraveWallet', 'Brave Wallet'],
  ['isOKExWallet', 'OKX'],
  ['isOkxWallet', 'OKX'],
  ['isTokenPocket', 'Token Pocket'],
  ['isBitKeep', 'BitKeep'],
  ['isMetaMask', 'MetaMask'],
]

const brandName = (provider: EIP1193Provider): string | undefined => {
  for (const [flag, name] of BRAND_FLAGS) {
    if ((provider as Record<string, unknown>)[flag] === true) return name
  }
  return undefined
}

// legacy fallback: window.ethereum (a providers array when several wallets coexist,
// the transitional pattern predating EIP-5749)
const listLegacyProviders = (): EIP1193Provider[] => {
  const eth = getInjected()
  if (!eth) return []
  if (Array.isArray(eth.providers) && eth.providers.length > 0) return eth.providers
  return [eth]
}

// EIP-6963 discovery + legacy fallback, normalized to a DiscoveredEvmWallet list.
// Requests announcements and waits briefly (wallets listen for requestProvider
// and answer asynchronously); the wait does not block the UI.
export async function discoverEvmWallets(timeoutMs = 500): Promise<DiscoveredEvmWallet[]> {
  const found = new Map<string, DiscoveredEvmWallet>()
  const onAnnounce = (e: Event) => {
    const detail = (e as CustomEvent).detail as { info?: Eip6963ProviderInfo; provider?: EIP1193Provider } | undefined
    const info = detail?.info
    if (!info?.uuid || !info.name || !detail?.provider) return
    if (found.has(info.uuid)) return
    found.set(info.uuid, { name: info.name, label: info.name, provider: detail.provider })
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  window.removeEventListener('eip6963:announceProvider', onAnnounce)
  if (found.size > 0) return [...found.values()]
  return listLegacyProviders().map((provider) => {
    const name = brandName(provider)
    return name
      ? { name, label: name, provider }
      : { name: t('wallet.connectEvm'), label: 'injected', provider }
  })
}

export async function connectEvmWallet(wallet: DiscoveredEvmWallet): Promise<EvmSigner> {
  const eth = wallet.provider
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts?.length) throw new Error(t('errors.evmNoAccounts'))
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: walletAddChainParams.chainId }] })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [walletAddChainParams] })
    } else throw e
  }
  const chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string
  const chainId = Number.parseInt(chainIdHex, 16)
  if (chainId !== AUTO_EVM_CHAIN_ID) {
    throw new Error(t('errors.evmWrongChain', [chainIdHex]))
  }
  // the label is a stable identifier (not copy); WalletBar maps it to a display name in the active locale
  return { kind: 'injected', address: accounts[0], provider: eth, chainId, label: wallet.label }
}

// Injected wallets are live — accounts and networks can change inside the
// wallet at any time, and an app-side signer that does not follow along would
// keep signing with a stale address or writing to the wrong chain. Wrapping
// the current provider's accountsChanged/chainChanged binding into a testable
// function (WalletBar calls it in an effect); returns a detach function that
// MUST be called when the signer is switched or disconnected. Listens only —
// never issues requests, never switches chains on the user's behalf.
export function attachEvmWalletEvents(
  provider: EIP1193Provider,
  handlers: {
    /** account change: empty array = disconnected/locked inside the wallet; non-empty = current account (possibly a different one) */
    onAccountsChanged: (accounts: string[]) => void
    /** network change: hex chainId (e.g. '0x366'). Only refreshes signer.chainId; the write guard lives in registry.walletClientFor */
    onChainChanged: (chainIdHex: string) => void
  },
): () => void {
  // Defensive optional access: viem types mark on/removeListener as required,
  // but legacy/low-quality providers may not implement them — degrade silently
  // to "no events" (same as the old behavior) when missing.
  const onAccounts = (accounts: unknown) => handlers.onAccountsChanged((accounts as string[]) ?? [])
  const onChain = (chainIdHex: unknown) => handlers.onChainChanged(String(chainIdHex))
  provider.on?.('accountsChanged', onAccounts)
  provider.on?.('chainChanged', onChain)
  return () => {
    provider.removeListener?.('accountsChanged', onAccounts)
    provider.removeListener?.('chainChanged', onChain)
  }
}
