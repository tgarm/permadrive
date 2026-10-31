// Wallet layer abstraction: dual signing capability — Substrate signing
// (publishing remarks) and EVM signing (FileRegistry registration) side by
// side. Multi-protocol wallets like Talisman can provide both at once.
//
// Two Substrate signer implementations:
//  - extension: a browser extension connected via auto-wallet
//    (Talisman/SubWallet/…, the production path), going through the Signer
//    interface (signPayload, signing inside the extension)
//  - local: direct KeyringPair signing (dev/acceptance path). No hand-written
//    signPayload — serialization of the signing payload depends on the chain's
//    signedExtensions definitions and must be constructed from api.registry;
//    passing the pair directly to tx.signAsync lets polkadot handle it correctly
//
// Two EVM signer implementations:
//  - injected: window.ethereum (MetaMask etc., EIP-1193), txs signed inside the extension
//  - local: a BIP44 m/44'/60'/0'/0/0 account derived from the same mnemonic
//    (viem HDAccount, dev/acceptance path — symmetric with the Substrate-side
//    local-keyring; the mnemonic is never written to disk)

import type { Signer } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { EIP1193Provider } from 'viem'
import type { HDAccount } from 'viem/accounts'

export interface SubstrateSigner {
  kind: 'extension' | 'local'
  address: string
  /** Extension wallet signer (extension path) */
  signer?: Signer
  /** Local key pair (local path; signAsync(pair) builds the payload correctly via api.registry) */
  pair?: KeyringPair
  label: string
}

// Auto-EVM signer (FileRegistry registration)
export interface EvmSigner {
  kind: 'injected' | 'local'
  address: string
  /** injected path: EIP-1193 provider (window.ethereum) */
  provider?: EIP1193Provider
  /** local path: viem HD account (local signing, sent straight to the RPC) */
  account?: HDAccount
  /** injected path: chainId verified at connect time, kept fresh by the
   *  wallet's chainChanged event (doc: after an in-wallet network switch,
   *  writes are rejected by the registry.walletClientFor guard); the local
   *  path talks to our own RPC (always 870) and has no such notion */
  chainId?: number
  label: string
}

export interface Wallet {
  substrate: SubstrateSigner | null
  evm: EvmSigner | null
}
