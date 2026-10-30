// Versioned text (append-only notes). One save = pack + publish the content →
// re-publish the manifest into the DSN → register in the FileRegistry; the
// authoritative version chain is the on-chain registry, the local IndexedDB is
// only a cache. The grouping protocol is the filename convention
// (pdnote-{id}-{slug}.md): the registry's name field and manifest.file.name
// share the same string, and the recovery side rebuilds the version list from it.
// Version numbers stay OUT of the filename: filenames feed content addressing,
// so an incrementing version would make "save with unchanged content" produce a
// new CID and destroy the dedup idempotency — version order derives from the
// on-chain heights instead.

import { t } from '../i18n/core.ts'

export const NOTE_FILE_PREFIX = 'pdnote-'

/** Note ID: random 4-byte hex (appears inside the filename, so a compact no-dash form) */
export const newNoteId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export interface NoteFileRef {
  id: string
  titleSlug: string
}

/** Filename-safe slug: collapses whitespace and filesystem/URL-hostile characters to '-' (titles may contain non-ASCII) */
export function slugifyTitle(title: string): string {
  const s = title
    .trim()
    .replace(/[\s/\\:*?"<>|#+%&]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (s || 'untitled').slice(0, 60)
}

export function noteFileName(id: string, title: string): string {
  return `${NOTE_FILE_PREFIX}${id}-${slugifyTitle(title)}.md`
}

export function parseNoteFileName(name: string): NoteFileRef | null {
  const m = /^pdnote-([0-9a-f]+)-(.+)\.md$/.exec(name)
  if (!m) return null
  return { id: m[1], titleSlug: m[2] }
}

/** slug → display title (lossy: '-' and spaces are indistinguishable; the recovery side uses it as initial display only, editing and saving corrects it) */
export const titleFromSlug = (slug: string): string => slug.replace(/-/g, ' ').trim() || t('notes.untitledNote')

/**
 * Group registry entries by note id (entries not matching the pdnote convention
 * are ignored); within a group, ascending height = version order (registeredAt
 * can tie for same-second saves, heights are strictly increasing).
 */
export function groupNoteEntries<T extends { name: string; height: number }>(entries: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const e of entries) {
    const ref = parseNoteFileName(e.name)
    if (!ref) continue
    const list = groups.get(ref.id) ?? []
    list.push(e)
    groups.set(ref.id, list)
  }
  for (const list of groups.values()) list.sort((a, b) => a.height - b.height)
  return groups
}
