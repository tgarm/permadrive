// Public-file download pipeline (extracted from SharePage decryptAndSave so
// the Share deep link and Discover share one flow): retrieve the ciphertext →
// ciphertext integrity gate (retrieve against cipherSha256/cipherSize) →
// AES-GCM decrypt with K → plaintext sha256/size verification → compare with
// the public declaration (Published event / bookmark; mandatory when present —
// D11: GCM authentication ≠ agreement with the public claim) → save. R09
// policy: a mismatch blocks saving; a forensic export needs explicit consent.
// Consumers: SharePage deep-link landing (k from the link or the event),
// Discover downloads (K from the event / local bookmark). The integrity gate
// mirrors the files-page download (retrieve.ts / fileCrypto division of labor
// unchanged). `confirm` is injected by the caller (pages pass the
// promise-based dialog from useConfirmDialog): the lib layer never raises UI
// directly, and the parameter is mandatory so the type checker forces every
// call site to wire it (no native window.confirm leftovers).

import type { ApiPromise } from '@polkadot/api'
import { fromHex, sha256Hex } from './bytes.ts'
import { retrieveFile } from './retrieve.ts'
import { aesGcmDecrypt } from './vaultCrypto.ts'
import { saveBlob } from './download.ts'
import type { Manifest } from './manifest.ts'
import { t } from '../i18n/core.ts'

/** Publisher declaration (Published event fields or their local bookmark copy); null = nothing to compare */
export interface PublicDeclaration {
  plainSha256: string
  plainSize: bigint
}

export async function decryptAndSavePublic(
  api: ApiPromise,
  manifest: Manifest,
  keyBytes: Uint8Array,
  say: (s: string) => void,
  declared: PublicDeclaration | null,
  confirm: (message: string) => Promise<boolean>,
): Promise<void> {
  if (!manifest.encryption) throw new Error(t('errors.manifestNotEncrypted'))
  const result = await retrieveFile(api, manifest)
  if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
  say(t('share.decryptingPublic'))
  const plain = await aesGcmDecrypt(keyBytes, fromHex(manifest.encryption.iv), result.bytes)
  const plainSha = await sha256Hex(plain)
  if (plainSha !== manifest.file.sha256 || plain.length !== manifest.file.size) {
    if (await confirm(t('share.integrityBlockExport', [plainSha.slice(0, 16)]))) saveBlob(plain, manifest.file.name, manifest.file.mimeType)
    return
  }
  if (declared) {
    const evSha = declared.plainSha256.replace(/^0x/, '').toLowerCase()
    if (evSha !== plainSha || Number(declared.plainSize) !== plain.length) {
      if (!(await confirm(t('share.eventMismatchExport')))) return
    }
  }
  saveBlob(plain, manifest.file.name, manifest.file.mimeType)
  say(t('share.decryptedOk', [manifest.file.name, plainSha.slice(0, 16)]))
}
