// EVM-side local signer (dev / acceptance path): mnemonic → BIP44 m/44'/60'/0'/0/0
// derivation (the same derivation path as the funding address in
// scripts/p2/xdm-transfer.mjs — a single mnemonic can operate both the
// consensus-chain account and the Auto-EVM account). The mnemonic stays in
// memory only and is never written to disk.

import { mnemonicToAccount } from 'viem/accounts'
import type { EvmSigner } from './types'

export async function createLocalEvmSigner(mnemonic: string): Promise<EvmSigner> {
  const account = mnemonicToAccount(mnemonic.trim())
  // the label is a stable identifier (not copy); WalletBar maps it to a display name in the active locale
  return { kind: 'local', address: account.address, account, label: 'local' }
}
