// File version grouping (2026-11-03): same-owner same-name files form a version
// chain ordered by consensus-chain height — every version is already an
// independent Registry entry (all versions live on-chain forever at the data
// layer); "overwrite" only happens in the directory view, which shows the
// latest version with history versions tucked into an expandable table.
// Isomorphic with notes' groupNoteEntries: version order derives from on-chain
// heights (ties fall back to submittedAt). Grouping/version numbers never go
// into the manifest — the manifest JSON is published on-chain in full, so any
// added field would change the manifestCid. The input is a minimal structural
// interface (Manifest satisfies it): pure function, directly testable in Node.

export interface VersionableManifest {
  rootCid: string
  file: { name: string; sha256: string; mimeType: string | null }
  txs: { height: number }[]
  submittedAt: string
}

/** Version order key: multi-batch uploads take the last batch height (publish
 *  order follows it); no txs (imported / publishing in progress) sorts as 0 */
export function versionHeight(m: VersionableManifest): number {
  return m.txs.length ? Math.max(...m.txs.map((tx) => tx.height)) : 0
}

export interface FileVersionGroup<T extends VersionableManifest = VersionableManifest> {
  /** Group key = original file name (manifest.file.name; same string registered as the Registry entry name) */
  name: string
  /** height ascending = version order (v1..vN); latest is the last element */
  versions: T[]
  latest: T
}

export function groupFileVersions<T extends VersionableManifest>(manifests: T[]): FileVersionGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const m of manifests) {
    const list = groups.get(m.file.name) ?? []
    list.push(m)
    groups.set(m.file.name, list)
  }
  const out: FileVersionGroup<T>[] = []
  for (const [name, list] of groups) {
    list.sort((a, b) => versionHeight(a) - versionHeight(b) || a.submittedAt.localeCompare(b.submittedAt))
    out.push({ name, versions: list, latest: list[list.length - 1] })
  }
  // Groups ordered by their latest version's time descending (the table's overall
  // order matches the previous single-file behavior: newest first)
  out.sort((a, b) => b.latest.submittedAt.localeCompare(a.latest.submittedAt))
  return out
}
