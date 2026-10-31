// Three-state share derivation: everything derives from on-chain evidence
// (consistent across devices); the local history markers (everSold/
// everDisclosed) are UI-only enhancements. Shared by the FilesTable badge and
// the SharePanel.
//
// Derivation:
//  - public: a Published event exists (source of truth; always filtered by
//    the configured publisher address)
//  - for-sale: an active listing (price >= 1 wei) and no Published event
//  - unshared: no listing and no Published event — NOT the same as
//    "readable only by me" (past sales/shared copies are unknowable on-chain)
//  - plaintext (born public): manifest without an encryption block (terminal)
//  - broadcast disclosure: disclosureAttempted persisted but no event visible
//    = public (unconfirmed), never unshared — the caller renders the marker

import { fetchPublishedByKey, hasDisclosureAttempted, hasEverDisclosed, hasEverSold, publicPublisherActive } from './publicPublisher.ts'
import { getListingSales, salesActive } from './sales.ts'
import { getManifestPublishMeta } from './manifestPublish.ts'
import type { Manifest } from './manifest.ts'
import type { RegistryRecord } from './store.ts'

export type ShareKind = 'plain' | 'unshared' | 'paid' | 'public'

export interface ShareInfo {
  kind: ShareKind
  /** The signature was handed to the wallet (a broadcast attempt happened) but
   *  no event is visible yet — the UI shows "public (unconfirmed)" */
  disclosureAttempted: boolean
  everSold: boolean
  everDisclosed: boolean
  /** The manifest's own location (a Registry entry wins, the meta sidecar
   *  backstops); null = not on the DSN yet */
  manifestCid: string | null
  height: number | null
}

export async function deriveShareInfo(
  manifest: Manifest,
  opts: { owner: string | null; registryRecord: RegistryRecord | null },
): Promise<ShareInfo> {
  const [everSold, everDisclosed, disclosureAttempted] = await Promise.all([
    hasEverSold(manifest.rootCid),
    hasEverDisclosed(manifest.rootCid),
    hasDisclosureAttempted(manifest.rootCid),
  ])
  const base: ShareInfo = { kind: 'unshared', disclosureAttempted, everSold, everDisclosed, manifestCid: null, height: null }

  if (manifest.encryption == null) return { ...base, kind: 'plain' }

  const meta = await getManifestPublishMeta(manifest.rootCid)
  const manifestCid = opts.registryRecord?.manifestCid ?? meta?.manifestCid ?? null
  const height = opts.registryRecord?.height ?? meta?.height ?? null
  if (!manifestCid) return base // not on the DSN: not derivable locally (selling/public always implies a manifest location first)

  try {
    const published = publicPublisherActive() ? await fetchPublishedByKey(manifestCid) : null
    if (published) return { ...base, kind: 'public', manifestCid, height }
    if (disclosureAttempted) return { ...base, kind: 'public', manifestCid, height } // public (unconfirmed)
    const listing = opts.owner && salesActive() ? await getListingSales(opts.owner, manifestCid) : null
    if (listing && listing.price > 0n) return { ...base, kind: 'paid', manifestCid, height }
  } catch {
    /* Derivation failure renders as unshared (never impersonates public; refresh retries) */
  }
  return { ...base, manifestCid, height }
}
