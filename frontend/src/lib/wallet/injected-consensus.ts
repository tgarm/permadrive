import type { Signer } from '@polkadot/api/types'
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto'
import { t } from '../../i18n/core.ts'

export interface ConsensusAccount {
  address: string
  name?: string
  type?: string
}
export interface ConsensusInjector {
  signer: Signer
  accounts: {
    get: () => Promise<ConsensusAccount[]>
    subscribe?: (callback: (accounts: ConsensusAccount[]) => void) => (() => void) | Promise<() => void>
  }
}
export interface ConsensusExtension {
  enable: (name: string) => Promise<ConsensusInjector>
}
export interface ConsensusWallet {
  extensionName: string
  title: string
  extension: ConsensusExtension
}
const TITLES: Record<string, string> = { talisman: 'Talisman', 'subwallet-js': 'SubWallet', 'polkadot-js': 'Polkadot.js' }

/** Discovery is read-only: enable is called only after a connect click. */
export function discoverConsensusWallets(injected?: Record<string, ConsensusExtension>): ConsensusWallet[] {
  const providers = injected ?? (typeof window === 'undefined' ? {} : (window as unknown as { injectedWeb3?: Record<string, ConsensusExtension> }).injectedWeb3 ?? {})
  return Object.entries(TITLES).flatMap(([extensionName, title]) => {
    const extension = providers[extensionName]
    return typeof extension?.enable === 'function' ? [{ extensionName, title, extension }] : []
  })
}

/** Mixed-wallet EVM and malformed accounts must not prevent valid AccountId32 use. */
export function consensusAccounts(raw: ConsensusAccount[]): ConsensusAccount[] {
  const accounts = new Map<string, ConsensusAccount>()
  for (const account of Array.isArray(raw) ? raw : []) {
    if (account?.type === 'ethereum' || typeof account?.address !== 'string') continue
    try {
      const key = decodeAddress(account.address)
      if (key.length !== 32) continue
      const address = encodeAddress(key, 6094)
      if (!accounts.has(address)) accounts.set(address, { ...account, address })
    } catch { /* Ignore unsupported accounts, not the entire connection. */ }
  }
  return [...accounts.values()]
}

export async function connectConsensusWallet(wallet: ConsensusWallet): Promise<{ injector: ConsensusInjector; accounts: ConsensusAccount[] }> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const injector = await wallet.extension.enable('PermaDrive')
        if (!injector?.signer || typeof injector.accounts?.get !== 'function') throw new Error(t('wallet.invalidConsensusExtension'))
        const accounts = consensusAccounts(await injector.accounts.get())
        if (!accounts.length) throw new Error(t('wallet.noConsensusAccounts'))
        return { injector, accounts }
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(t('wallet.connectionTimeout'))), 30_000) }),
    ])
  } finally { clearTimeout(timeout) }
}
