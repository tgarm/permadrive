// Local file ownership: the basis for scoping "My Files" to the connected EVM
// address (doc — 2026-11-01). Ownership data lives only locally (meta sidecar
// + RegistryRecord); the Manifest structure is deliberately untouched because
// the manifest JSON is published to the chain in full (manifestPublish
// JSON.stringify) — adding a field would change the manifestCid and the
// recovery envelope bytes. Three sources, strongest first:
//   1. RegistryRecord.evmAddress (on-chain registration, joined by rootCid;
//      the same file may be registered by several accounts, so check for "me"
//      first)
//   2. meta stamp fileOwner:${rootCid} (written by the publish/recovery entry
//      points on success, lowercased)
//   3. Manifest.uploader.address (a Substrate address) === the connected
//      consensus signer — a fallback for legacy unstamped uploads (with
//      extension wallets the EVM and Substrate addresses differ, so this only
//      matches when the same signer reconnects)
// Nothing matching at all = unknown → the "unowned" group, claimed manually
// (never silently attributed, never silently hidden). Schemaless upgrade
// policy: no DB version bump, read-time normalization (same as store.ts).

import { getMeta, putMeta } from './store.ts'
import type { RegistryRecord } from './store.ts'
import type { Manifest } from './manifest.ts'

const ownerKey = (rootCid: string) => `fileOwner:${rootCid}`

/** Stamp on success at the publish/recovery entry points (lowercased; all comparisons are case-insensitive) */
export const stampFileOwner = (rootCid: string, evmAddress: string): Promise<void> =>
  putMeta(ownerKey(rootCid), evmAddress.toLowerCase())

export const getStampedOwner = async (rootCid: string): Promise<string | null> => {
  const v = await getMeta<string>(ownerKey(rootCid))
  return v ? v.toLowerCase() : null
}

export type OwnerVerdict = 'mine' | 'other' | 'unknown'

export interface OwnershipInput {
  myAddress: string
  /** Connected consensus signer address (for the uploader fallback); null when disconnected */
  mySubstrateAddress: string | null
  /** All local registration records for this manifest.rootCid (the caller may pass them unfiltered; the function compares itself) */
  records: RegistryRecord[]
}

export async function resolveOwnership(manifest: Manifest, opts: OwnershipInput): Promise<OwnerVerdict> {
  const me = opts.myAddress.toLowerCase()
  if (opts.records.some((r) => r.evmAddress.toLowerCase() === me)) return 'mine'
  const stamped = await getStampedOwner(manifest.rootCid)
  if (stamped) return stamped === me ? 'mine' : 'other'
  if (opts.mySubstrateAddress && manifest.uploader?.address === opts.mySubstrateAddress) return 'mine'
  if (opts.records.length > 0) return 'other'
  return 'unknown'
}
