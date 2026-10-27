// Vault crypto primitives (pure WebCrypto, works in browsers and Node 18+).
// Envelope model: a random 256-bit data key K encrypts the entry payload, and
// K itself is wrapped by independent channels —
//   passphrase-v1  user passphrase PBKDF2-SHA256(310k) derives a KEK → exported
//                  as the keystore file (the universal recovery path: the vault
//                  still opens even if the wallet is gone)
//   signature-v1   EVM wallet signs a fixed message → HKDF-SHA256 derives a
//                  KEK → wrapped into the envelope's wrappedKeys[] (the
//                  convenience path: same wallet on a new device unlocks
//                  without the passphrase). The signature itself never goes
//                  on-chain (that would publish the key material), and the
//                  channel requires reproducible signatures — sr25519 is
//                  empirically non-reproducible, so this path only works for
//                  EVM signers; injected wallets try at unlock time and fall
//                  back to the keystore on failure, so there is no deadlock.
// Deliberately NOT using @autonomys/auto-dag-data's encryption parameter: it
// supports a single password (cannot express multi-recipient wrapping), and
// encrypting at the envelope layer keeps the DAG standard-encoded — the
// retrieval pipeline needs zero changes and the manifest keeps encryption: null.

import { fromHex, toHex } from './bytes'
import { t } from '../i18n'

export interface WrappedKey {
  mode: 'signature-v1' | 'passphrase-v1'
  /** signature-v1: the derivation message (byte-stable across devices; also the scope statement shown in the wallet popup) */
  message?: string
  /** passphrase-v1: KDF parameters */
  kdf?: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }
  /** signature-v1: HKDF salt */
  salt?: string
  /** wrapping-layer AES-GCM IV */
  iv: string
  /** ciphertext of the wrapped K (32 bytes) */
  ct: string
}

export interface VaultCipher {
  alg: 'AES-256-GCM'
  iv: string
  ct: string
}

export interface VaultEnvelopeV1 {
  v: 1
  kind: 'permadrive-vault'
  /** owner EVM address (lowercase) */
  address: string
  createdAt: number
  updatedAt: number
  cipher: VaultCipher
  wrappedKeys: WrappedKey[]
}

/** keystore file = the passphrase channel exported standalone (same shape as the envelope's wrappedKeys) */
export interface KeystoreFileV1 {
  v: 1
  kind: 'permadrive-keystore'
  address: string
  createdAt: number
  wrapped: WrappedKey
}

const KEK_SALT_SIZE = 16
const IV_SIZE = 12
export const PBKDF2_ITERATIONS = 310_000
/** HKDF info (domain separation, keeps the KEK from being reused in other protocols) */
export const VAULT_KEK_INFO = 'permadrive-vault-kek-v1'

const enc = new TextEncoder()
const dec = new TextDecoder()

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))
export const randomHex = (nBytes: number): string => toHex(randomBytes(nBytes))

// ---- AES-GCM ----

const importAesKey = async (keyBytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new Uint8Array(keyBytes) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function aesGcmEncrypt(keyBytes: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) as BufferSource }, key, new Uint8Array(plaintext) as BufferSource)
  return new Uint8Array(ct)
}

export async function aesGcmDecrypt(keyBytes: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) as BufferSource }, key, new Uint8Array(ciphertext) as BufferSource)
  return new Uint8Array(pt)
}

// ---- KEK derivation ----

export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, lengthBytes = 32): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(ikm) as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt) as BufferSource, info: enc.encode(info) as BufferSource },
    base,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

export async function pbkdf2Sha256(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt) as BufferSource, iterations },
    material,
    256,
  )
  return new Uint8Array(bits)
}

// ---- K wrap / unwrap ----

export async function wrapKeyWithSignature(vaultKey: Uint8Array, message: string, signature: Uint8Array): Promise<WrappedKey> {
  const salt = randomBytes(KEK_SALT_SIZE)
  const kek = await hkdfSha256(signature, salt, VAULT_KEK_INFO)
  const iv = randomBytes(IV_SIZE)
  const ct = await aesGcmEncrypt(kek, iv, vaultKey)
  return { mode: 'signature-v1', message, salt: toHex(salt), iv: toHex(iv), ct: toHex(ct) }
}

/** Non-reproducible signatures (some injected wallets) fail GCM auth → returns null, caller falls back to the keystore */
export async function tryUnwrapWithSignature(wrapped: WrappedKey, signature: Uint8Array): Promise<Uint8Array | null> {
  if (wrapped.mode !== 'signature-v1' || !wrapped.salt) return null
  try {
    const kek = await hkdfSha256(signature, fromHex(wrapped.salt), VAULT_KEK_INFO)
    return await aesGcmDecrypt(kek, fromHex(wrapped.iv), fromHex(wrapped.ct))
  } catch {
    return null
  }
}

export async function wrapKeyWithPassphrase(vaultKey: Uint8Array, passphrase: string): Promise<WrappedKey> {
  const salt = randomBytes(KEK_SALT_SIZE)
  const kek = await pbkdf2Sha256(passphrase, salt, PBKDF2_ITERATIONS)
  const iv = randomBytes(IV_SIZE)
  const ct = await aesGcmEncrypt(kek, iv, vaultKey)
  return { mode: 'passphrase-v1', kdf: { alg: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toHex(salt) }, iv: toHex(iv), ct: toHex(ct) }
}

/** Wrong passphrase → GCM auth fails and throws (the keystore unlock path's error exit) */
export async function unwrapWithPassphrase(wrapped: WrappedKey, passphrase: string): Promise<Uint8Array> {
  if (wrapped.mode !== 'passphrase-v1' || !wrapped.kdf) throw new Error(t('errors.keystoreNotPassphraseWrapped'))
  const kek = await pbkdf2Sha256(passphrase, fromHex(wrapped.kdf.salt), wrapped.kdf.iterations)
  return aesGcmDecrypt(kek, fromHex(wrapped.iv), fromHex(wrapped.ct))
}

// ---- payload seal / open ----

export async function sealPayload(vaultKey: Uint8Array, plaintextJson: string): Promise<VaultCipher> {
  const iv = randomBytes(IV_SIZE)
  const ct = await aesGcmEncrypt(vaultKey, iv, enc.encode(plaintextJson))
  return { alg: 'AES-256-GCM', iv: toHex(iv), ct: toHex(ct) }
}

/** Auth failure (wrong K / tampered ciphertext) throws */
export async function openPayload(vaultKey: Uint8Array, cipher: VaultCipher): Promise<string> {
  if (cipher.alg !== 'AES-256-GCM') throw new Error(t('errors.envelopeUnknownAlg', [cipher.alg]))
  return dec.decode(await aesGcmDecrypt(vaultKey, fromHex(cipher.iv), fromHex(cipher.ct)))
}
