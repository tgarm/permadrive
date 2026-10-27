// Vault orchestration: envelope seal/open + signature wrapping + on-chain
// locating conventions. One EVM address = one vault; the envelope filename is
// pdvault-{addr8}.json (content addressing: every reseal uses a fresh IV → new
// CID → new version). K is generated once and never changes (one keystore is
// valid for all versions; wrappedKeys carry over unchanged across versions).

import { fromHex } from './bytes'
import { t } from '../i18n'
import {
  sealPayload,
  tryUnwrapWithSignature,
  wrapKeyWithPassphrase,
  wrapKeyWithSignature,
  type KeystoreFileV1,
  type VaultEnvelopeV1,
  type WrappedKey,
} from './vaultCrypto'
import { walletClientFor } from './registry'
import type { EvmSigner } from './wallet/types'

export const VAULT_FILE_PREFIX = 'pdvault-'
export const VAULT_SIGN_MESSAGE_PREFIX = 'PermaDrive vault key wrap v1'
const ADDR8 = /^pdvault-([0-9a-f]{8})\.json$/

/** Derivation message: byte-stable across devices (the unlock side must sign exactly this), visible in the wallet popup */
export const vaultSignMessage = (address: string): string => `${VAULT_SIGN_MESSAGE_PREFIX} · ${address.toLowerCase()}`

export const vaultFileName = (address: string): string => `${VAULT_FILE_PREFIX}${address.slice(2, 10)}.json`

export function parseVaultFileName(name: string): { address8: string } | null {
  const m = ADDR8.exec(name)
  return m ? { address8: m[1] } : null
}

/** EVM signature (injected goes through the wallet popup, local uses viem RFC6979 — verified deterministic) */
export async function signEvmMessage(signer: EvmSigner, message: string): Promise<Uint8Array> {
  const wallet = walletClientFor(signer)
  const account = signer.kind === 'injected' ? (signer.address as `0x${string}`) : signer.account!
  const sig = await wallet.signMessage({ message, account })
  return fromHex(sig)
}

export interface VaultEntry {
  id: string
  title: string
  username: string
  password: string
  url: string
  notes: string
  createdAt: number
  updatedAt: number
}

export const newVaultEntryId = (): string => crypto.randomUUID()

export interface CreateVaultResult {
  envelope: VaultEnvelopeV1
  vaultKey: Uint8Array
  /** the keystore file the create flow forces you to download (the only universal recovery path) */
  keystore: KeystoreFileV1
  entries: VaultEntry[]
}

export async function createVaultEnvelope(address: string, passphrase: string, signature: Uint8Array | null): Promise<CreateVaultResult> {
  const now = Date.now()
  const vaultKey = crypto.getRandomValues(new Uint8Array(32))
  const wrappedPass = await wrapKeyWithPassphrase(vaultKey, passphrase)
  const wrappedKeys: WrappedKey[] = [wrappedPass]
  if (signature) wrappedKeys.push(await wrapKeyWithSignature(vaultKey, vaultSignMessage(address), signature))
  const cipher = await sealPayload(vaultKey, JSON.stringify({ entries: [] satisfies VaultEntry[] }))
  const envelope: VaultEnvelopeV1 = {
    v: 1,
    kind: 'permadrive-vault',
    address: address.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    cipher,
    wrappedKeys,
  }
  const keystore: KeystoreFileV1 = { v: 1, kind: 'permadrive-keystore', address: address.toLowerCase(), createdAt: now, wrapped: wrappedPass }
  return { envelope, vaultKey, keystore, entries: [] }
}

/** Reseal (before publishing): entries changed → fresh IV/ciphertext; wrappedKeys carry over unchanged */
export async function resealVaultEnvelope(prev: VaultEnvelopeV1, entries: VaultEntry[], vaultKey: Uint8Array): Promise<VaultEnvelopeV1> {
  return { ...prev, updatedAt: Date.now(), cipher: await sealPayload(vaultKey, JSON.stringify({ entries })) }
}

/** Envelope JSON structural validation (data recovered from chain is untrusted); throws when invalid */
export function parseEnvelope(raw: unknown): VaultEnvelopeV1 {
  const v = raw as Partial<VaultEnvelopeV1> | null
  if (typeof v !== 'object' || v === null) throw new Error(t('errors.envelopeNotJson'))
  if (v.v !== 1 || v.kind !== 'permadrive-vault') throw new Error(t('errors.notEnvelope'))
  if (typeof v.address !== 'string' || typeof v.createdAt !== 'number' || typeof v.updatedAt !== 'number')
    throw new Error(t('errors.envelopeIncomplete'))
  if (!v.cipher || v.cipher.alg !== 'AES-256-GCM' || typeof v.cipher.iv !== 'string' || typeof v.cipher.ct !== 'string')
    throw new Error(t('errors.envelopeCipherInvalid'))
  if (!Array.isArray(v.wrappedKeys) || v.wrappedKeys.length === 0) throw new Error(t('errors.envelopeNoWrapChannels'))
  return v as VaultEnvelopeV1
}

/** keystore JSON validation (import path); owner mismatch is compared by the caller */
export function parseKeystoreFile(raw: unknown): KeystoreFileV1 {
  const v = raw as Partial<KeystoreFileV1> | null
  if (typeof v !== 'object' || v === null || v.v !== 1 || v.kind !== 'permadrive-keystore') throw new Error(t('errors.notKeystore'))
  if (typeof v.address !== 'string' || !v.wrapped || v.wrapped.mode !== 'passphrase-v1') throw new Error(t('errors.keystoreFieldsInvalid'))
  return v as KeystoreFileV1
}

/**
 * Wallet-signature unlock: sign the fixed message fresh → try the unwrap.
 * Deterministic signers (local EVM verified; most injected wallets too)
 * succeed; non-reproducible signatures return null — the caller points the
 * user at the keystore.
 */
export async function unlockVaultWithSignature(envelope: VaultEnvelopeV1, signer: EvmSigner): Promise<Uint8Array | null> {
  const wrap = envelope.wrappedKeys.find((w) => w.mode === 'signature-v1')
  if (!wrap) return null
  const message = wrap.message ?? vaultSignMessage(envelope.address)
  const signature = await signEvmMessage(signer, message)
  return tryUnwrapWithSignature(wrap, signature)
}

/** Entry payload (decrypted from the envelope cipher) → structural validation */
export function parseVaultEntries(plaintextJson: string): VaultEntry[] {
  const parsed = JSON.parse(plaintextJson) as { entries?: unknown }
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error(t('errors.payloadInvalid'))
  return parsed.entries as VaultEntry[]
}
