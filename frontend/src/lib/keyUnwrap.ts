// Manifest encryption-block key unwrapping (moved out of paywall.ts on
// 2026-10-31 when the paid-download frontend was removed; direct sales keeps
// using it): recovers the data key K from manifest.encryption.wrappedKeys —
// signature channel first (EVM signature → HKDF, deterministic for local
// RFC6979 keys), falling back to the passphrase channel on failure/refusal
// (getPassphrase is injected by the caller; FilesPage's passphrase prompt is
// that callback). Consumers: sales.ts (seller delivery), SalesSection (buyer
// decrypt-and-download).

import { fromHex } from './bytes.ts'
import { accountOf, walletClientFor } from './registry.ts'
import { tryUnwrapWithSignature, unwrapWithPassphrase } from './vaultCrypto.ts'
import type { Manifest } from './manifest.ts'
import type { EvmSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

/** Unwrap K from the manifest encryption block: signature channel first (deterministic signer), passphrase fallback */
export async function unwrapManifestKey(
  signer: EvmSigner,
  manifest: Manifest,
  getPassphrase: () => Promise<string | null>,
): Promise<Uint8Array> {
  if (!manifest.encryption) throw new Error(t('errors.manifestNotEncrypted'))
  const sigWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'signature-v1')
  if (sigWrap) {
    try {
      const wallet = walletClientFor(signer)
      const signature = fromHex(await wallet.signMessage({ message: sigWrap.message ?? '', account: accountOf(signer) }))
      const key = await tryUnwrapWithSignature(sigWrap, signature)
      if (key) return key
    } catch {
      // signature refused → fall back to passphrase
    }
  }
  const passWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'passphrase-v1')
  if (!passWrap) throw new Error(t('errors.fileDecryptNoChannel'))
  const passphrase = await getPassphrase()
  if (passphrase === null) throw new Error(t('errors.fileDecryptCancelled'))
  return unwrapWithPassphrase(passWrap, passphrase)
}
