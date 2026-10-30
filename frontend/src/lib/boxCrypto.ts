// Two-channel box encryption. x25519-xsalsa20-poly1305 (nacl box) envelopes,
// field-compatible with MetaMask eth_getEncryptionPublicKey / eth_decrypt
// (the injected path is pending real-device verification):
//   injected  encryption pubkey = eth_getEncryptionPublicKey (wallet-hosted);
//             reading = eth_decrypt (decrypted inside the wallet)
//   local     keypair derived deterministically: seed = sha256(EVM signature)
//             (RFC6979 is reproducible; sr25519/injected signatures are not),
//             so the same mnemonic yields the same keypair on any device.
//             tweetnacl 1.0.3 has no box.keyPair.fromSeed — equivalent manual
//             derivation: sk = seed, pk = scalarMult.base(sk) (clamped inside
//             scalarmult).
// The sender encrypts with a throwaway ephemeral keypair; the recipient only
// ever sees the ephemeral public key.
// This module does not depend on registry/config (signing callback injected),
// so the Node selftest can import it directly.

import nacl from 'tweetnacl'
import { sha256Hex } from './bytes.ts'
import { t } from '../i18n/core.ts'

export const MAILBOX_ENC_KEY_MESSAGE_PREFIX = 'PermaDrive mailbox encryption key v1'

/** Derivation message: what the local channel signs for its keypair seed (byte-stable across devices) */
export const mailboxEncKeyMessage = (address: string): string => `${MAILBOX_ENC_KEY_MESSAGE_PREFIX} · ${address.toLowerCase()}`

/** MetaMask-compatible envelope (all base64) — JSON.stringify of this is what gets announced/sent on-chain */
export interface BoxEnvelope {
  version: 'x25519-xsalsa20-poly1305'
  nonce: string
  ephemPublicKey: string
  ciphertext: string
}

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** base64 announced encryption pubkey → raw bytes (boxEncrypt input format) */
export const publicKeyFromBase64 = fromB64

/**
 * Local-channel x25519 keypair (deterministic): signature → sha256 → seed.
 * The signing callback is injected by the caller; the same mnemonic derives
 * the same keypair on any device.
 */
export async function localBoxKeypair(
  signMessage: (message: string) => Promise<Uint8Array>,
  address: string,
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const signature = await signMessage(mailboxEncKeyMessage(address))
  const seed = new Uint8Array(32)
  ;(await sha256Hex(signature)).match(/../g)?.forEach((h, i) => (seed[i] = parseInt(h, 16)))
  const secretKey = seed
  const publicKey = nacl.scalarMult.base(secretKey)
  return { publicKey, secretKey }
}

/** Encrypt to a recipient pubkey (the announced base64 or locally derived raw bytes) */
export function boxEncrypt(recipientPublicKey: Uint8Array, plaintext: Uint8Array): BoxEnvelope {
  const ephem = nacl.box.keyPair()
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, ephem.secretKey)
  return {
    version: 'x25519-xsalsa20-poly1305',
    nonce: toB64(nonce),
    ephemPublicKey: toB64(ephem.publicKey),
    ciphertext: toB64(ciphertext),
  }
}

/** Local-channel decryption (tampered envelope or wrong key → nacl returns null → throws) */
export function boxDecryptWithSecretKey(envelope: BoxEnvelope, secretKey: Uint8Array): Uint8Array {
  if (envelope.version !== 'x25519-xsalsa20-poly1305') throw new Error(t('errors.boxUnknownVersion', [envelope.version]))
  const opened = nacl.box.open(fromB64(envelope.ciphertext), fromB64(envelope.nonce), fromB64(envelope.ephemPublicKey), secretKey)
  if (!opened) throw new Error(t('errors.boxDecryptFailed'))
  return opened
}

/** Envelope serialization/parsing (shared by on-chain content and local cache) */
export const serializeEnvelope = (envelope: BoxEnvelope): string => JSON.stringify(envelope)
export function parseEnvelope(content: string): BoxEnvelope {
  const v = JSON.parse(content) as BoxEnvelope
  if (v?.version !== 'x25519-xsalsa20-poly1305' || !v.nonce || !v.ephemPublicKey || !v.ciphertext)
    throw new Error(t('errors.boxEnvelopeInvalid'))
  return v
}

// ---- injected wallet channel (MetaMask family; Talisman et al. unverified — fall back to the local key on failure) ----

// eth_getEncryptionPublicKey / eth_decrypt are not part of viem's standard
// EIP1193Provider method union — send them through a loosely typed request
// (EIP-1193 explicitly allows custom methods).
type RawEip1193Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>

function reqOf(provider: unknown): RawEip1193Request {
  const p = provider as { request?: RawEip1193Request }
  if (!p || typeof p.request !== 'function') throw new Error(t('errors.injectedNoProvider'))
  return p.request.bind(provider)
}

/** Encryption pubkey (wallet-hosted, the announced value; base64 x25519 pubkey) */
export async function injectedEncryptionPublicKey(provider: unknown, address: string): Promise<string> {
  const key = await reqOf(provider)({ method: 'eth_getEncryptionPublicKey', params: [address] })
  if (typeof key !== 'string' || key.length === 0) throw new Error(t('errors.boxNoEncryptionPublicKey'))
  return key
}

/**
 * In-wallet decryption (plaintext never touches the frontend). MetaMask
 * returns hex or utf8 — both are normalized to bytes for the caller to decode.
 */
export async function injectedDecrypt(provider: unknown, address: string, envelopeJson: string): Promise<Uint8Array> {
  const out = await reqOf(provider)({ method: 'eth_decrypt', params: [envelopeJson, address] })
  if (typeof out !== 'string' || out.length === 0) throw new Error(t('errors.boxDecryptFailed'))
  if (out.startsWith('0x')) {
    const clean = out.slice(2)
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  return new TextEncoder().encode(out)
}
