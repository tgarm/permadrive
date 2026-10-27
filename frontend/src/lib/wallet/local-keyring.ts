// Local keyring signer (dev / acceptance path): enter a mnemonic to create a
// one-off key pair. The mnemonic is kept only in memory and component state
// (gone when the tab closes) and is never persisted to disk — the production
// path is the browser extension wallet (auto-wallet).
// Signing uses direct KeyringPair signing (see the notes in wallet/types.ts);
// the address displays with Autonomys ss58-6094 (signing uses the public key,
// the encoding does not affect verification).

import { Keyring } from '@polkadot/api'
import { cryptoWaitReady } from '@polkadot/util-crypto'
import type { SubstrateSigner } from './types'

export async function createLocalSigner(mnemonic: string): Promise<SubstrateSigner> {
  await cryptoWaitReady()
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 6094 })
  const pair = keyring.addFromMnemonic(mnemonic)
  // the label is a stable identifier (not copy); WalletBar maps it to a display name in the active locale
  return { kind: 'local', address: pair.address, pair, label: 'local' }
}
