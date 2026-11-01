// Incremental on-chain directory reconciliation (the orchestration layer behind
// the files page's automatic recovery).
//
// fetchEntries is a single full-array view call (cheap, read-only, no wallet
// prompt); the only expensive part is the per-entry block scan
// (recoverManifestFromHint, ~2-5 RPCs per entry, paced by PacedHttpProvider).
// "Only query what is new" therefore reconciles at entry granularity: a
// RegistryRecord is written by BOTH the publish-registration and the recovery
// paths, so it is the "this entry is already synced into the local cache"
// marker — the per-entry equivalent of a cursor, which naturally supports
// retrying partial failures (a failed entry has no record and is retried next
// time) without cursor checkpoint/reorg bookkeeping. Deleting a file locally
// keeps its record, so automatic recovery never resurrects deleted files; the
// manual mode (rescanAll) rescans everything — an explicit intent is what
// brings deleted files back.
//
// All dependencies are injected: directly testable in Node via type-stripping
// (scripts/verify/directory-sync-test.mjs); the browser wires it in FilesPage.

import type { Manifest } from './manifest.ts'
import type { RegistryRecord } from './store.ts'

export interface DirectoryEntry {
  manifestCid: string
  height: number
  name: string
}

export interface DirectorySyncFailure {
  name: string
  message: string
}

export interface DirectorySyncDeps {
  address: string
  /** true = the manual "recover from registry" button: rescan everything (can bring back locally deleted files) */
  rescanAll?: boolean
  fetchEntries: (address: string) => Promise<DirectoryEntry[]>
  listManifests: () => Promise<Manifest[]>
  listRegistryRecords: () => Promise<RegistryRecord[]>
  putManifest: (manifest: Manifest) => Promise<void>
  putRegistryRecord: (record: RegistryRecord) => Promise<void>
  /** restore one entry by block scan (the caller lazily connects the consensus chain) */
  recover: (entry: DirectoryEntry) => Promise<Manifest>
}

export interface DirectorySyncProgress {
  index: number
  total: number
  entry: DirectoryEntry
}

export interface DirectorySyncResult {
  empty: boolean
  total: number
  recovered: number
  skipped: number
  failed: DirectorySyncFailure[]
}

export async function syncDirectoryFromRegistry(
  deps: DirectorySyncDeps,
  onProgress?: (p: DirectorySyncProgress) => void,
): Promise<DirectorySyncResult> {
  const entries = await deps.fetchEntries(deps.address)
  if (entries.length === 0) return { empty: true, total: 0, recovered: 0, skipped: 0, failed: [] }

  const addr = deps.address.toLowerCase()
  const [manifests, records] = await Promise.all([deps.listManifests(), deps.listRegistryRecords()])
  // reconciled set: manifestCids of this address's records ∪ local manifests'
  // rootCid / recovery.manifestCid (the latter covers "registered but the
  // record write was interrupted" and old-format imports without a record;
  // addresses are compared case-insensitively).
  const known = new Set<string>()
  for (const r of records) {
    if (r.evmAddress.toLowerCase() === addr) known.add(r.manifestCid)
  }
  const knownRootCids = new Set<string>()
  for (const m of manifests) {
    knownRootCids.add(m.rootCid)
    known.add(m.rootCid)
    if (m.recovery) known.add(m.recovery.manifestCid)
  }

  let recovered = 0
  let skipped = 0
  const failed: DirectorySyncFailure[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    onProgress?.({ index: i, total: entries.length, entry })
    if (!deps.rescanAll && known.has(entry.manifestCid)) {
      skipped++
      continue
    }
    try {
      const manifest = await deps.recover(entry)
      await deps.putManifest(manifest)
      await deps.putRegistryRecord({
        rootCid: manifest.rootCid,
        manifestCid: entry.manifestCid,
        height: entry.height,
        evmAddress: deps.address,
        syncedAt: Date.now(),
      })
      // the manual full rescan keeps the historical counting: on-chain entries
      // whose manifest is already local count as skipped
      if (deps.rescanAll && knownRootCids.has(manifest.rootCid)) skipped++
      else recovered++
    } catch (e) {
      // one failure does not abort the run: the failed entry has no record, so
      // the next automatic sync / manual retry only re-processes failures
      failed.push({ name: entry.name, message: (e as Error).message })
    }
  }
  return { empty: false, total: entries.length, recovered, skipped, failed }
}
