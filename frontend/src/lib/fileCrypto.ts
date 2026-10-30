// File encryption. Envelope model reuses the vault primitives (vaultCrypto):
// a random data key K (32B) encrypts the file bytes with AES-256-GCM, and K is
// wrapped by independent channels (EVM signature → HKDF, plus a passphrase →
// PBKDF2). Difference from the vault: the signing message is scoped to files
// ("file key wrap v1"), and the signer's determinism is self-checked at
// encryption time (same message signed twice — local EVM keys are RFC6979-
// deterministic, injected wallets are not; nondeterministic signers must
// provide the passphrase channel).
// Privacy boundary (same as Notes): filename/size/ciphertext are public and
// retrievable by anyone; the content stays confidential.
// The signing callback is injected by the caller (FilesPage passes
// signEvmMessage); this module does not depend on registry/config, so the
// Node-side selftest can import and exercise it directly.
// Retrieval pipeline untouched: the ciphertext is packed into the standard
// DAG; ciphertext integrity is checked against encryption.cipherSha256 in
// retrieve, and the plaintext sha256 (manifest.file.sha256) after decrypt in
// FilesPage.

import { fromHex, sha256Hex, toHex } from './bytes.ts'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  randomBytes,
  tryUnwrapWithSignature,
  unwrapWithPassphrase,
  wrapKeyWithPassphrase,
  wrapKeyWithSignature,
} from './vaultCrypto.ts'
import type { ManifestEncryption } from './manifest.ts'
import { t } from '../i18n/core.ts'

export const FILE_SIGN_MESSAGE_PREFIX = 'PermaDrive file key wrap v1'

/** Derivation message: byte-stable across devices (the decrypting side must sign the same string); visible in the wallet popup */
export const fileSignMessage = (address: string): string => `${FILE_SIGN_MESSAGE_PREFIX} · ${address.toLowerCase()}`

/** One encryption session: wrap channels (signature / passphrase) can be appended until confirm */
export interface EncryptSession {
  /** The data key K (session memory only, never persisted into the manifest or the DB) */
  key: Uint8Array
  cipher: Uint8Array
  encryption: ManifestEncryption
}

/** Step 1 (no signer needed): K + AES-256-GCM; wrappedKeys starts empty */
export async function startEncryption(plain: Uint8Array): Promise<EncryptSession> {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = await aesGcmEncrypt(key, iv, plain)
  return {
    key,
    cipher,
    encryption: {
      scheme: 'pdenc-v1',
      iv: toHex(iv),
      cipherSha256: await sha256Hex(cipher),
      cipherSize: cipher.length,
      wrappedKeys: [],
    },
  }
}

/**
 * Signature channel with a determinism self-check: the same message is signed
 * twice and compared. Equal → wrap and return true; different or refused →
 * return false (no wrap) and the caller must supply a passphrase channel.
 */
export async function addSignatureChannel(
  session: EncryptSession,
  address: string,
  signMessage: (message: string) => Promise<Uint8Array>,
): Promise<boolean> {
  const message = fileSignMessage(address)
  let s1: Uint8Array
  let s2: Uint8Array
  try {
    s1 = await signMessage(message)
    s2 = await signMessage(message)
  } catch {
    return false
  }
  if (toHex(s1) !== toHex(s2)) return false
  session.encryption.wrappedKeys.push(await wrapKeyWithSignature(session.key, message, s1))
  return true
}

/** Passphrase channel (the universal recovery path when signatures are unavailable on a new device) */
export async function addPassphraseChannel(session: EncryptSession, passphrase: string): Promise<void> {
  session.encryption.wrappedKeys.push(await wrapKeyWithPassphrase(session.key, passphrase))
}

/** Pre-publish check: at least one wrap channel, otherwise K has no legal unlock path */
export function requireChannel(session: EncryptSession): void {
  if (session.encryption.wrappedKeys.length === 0) throw new Error(t('errors.fileEncryptionNoChannel'))
}

/**
 * Download decryption: try the signature channel with a fresh signature → on
 * failure (non-reproducible signature / other wallet / refusal) fall back to
 * the passphrase channel; getPassphrase returning null means cancelled. A
 * wrong passphrase surfaces as a GCM authentication failure.
 */
export async function decryptFileBytes(
  cipher: Uint8Array,
  encryption: ManifestEncryption,
  signMessage: ((message: string) => Promise<Uint8Array>) | null,
  getPassphrase: () => Promise<string | null>,
): Promise<Uint8Array> {
  if (encryption.scheme !== 'pdenc-v1') throw new Error(t('errors.manifestEncryptionScheme', [encryption.scheme]))
  let key: Uint8Array | null = null
  const sigWrap = encryption.wrappedKeys.find((w) => w.mode === 'signature-v1')
  if (sigWrap && signMessage) {
    try {
      const signature = await signMessage(sigWrap.message ?? fileSignMessage(''))
      key = await tryUnwrapWithSignature(sigWrap, signature)
    } catch {
      key = null
    }
  }
  if (!key) {
    const passWrap = encryption.wrappedKeys.find((w) => w.mode === 'passphrase-v1')
    if (!passWrap) throw new Error(t('errors.fileDecryptNoChannel'))
    const passphrase = await getPassphrase()
    if (passphrase === null) throw new Error(t('errors.fileDecryptCancelled'))
    key = await unwrapWithPassphrase(passWrap, passphrase)
  }
  return aesGcmDecrypt(key, fromHex(encryption.iv), cipher)
}
