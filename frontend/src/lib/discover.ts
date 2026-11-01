// Discover feed assembly: Published events are the network-wide index of
// public files. This module only does pure assembly (dedupe / sorting /
// follow filtering / buyer-count enrichment) plus local follows and bookmarks
// (meta sidecar); the EVM scans (listPublishedEvents /
// fetchBuyerCountsByFileKey) and page wiring stay with the caller. Deps are
// injected so it tests offline in Node (same style as directorySync).
// The D10 trust domain is unchanged: event fields are publisher claims, not
// content authentication — the download path must fully retrieve, decrypt and
// verify (D11, publicDownload.ts).

import { getMeta, putMeta } from './store.ts'
import type { PublishedEvent } from './publicPublisher.ts'

export interface DiscoverItem extends PublishedEvent {
  /** Unique buyer count (hot ranking; undefined when aggregation fails or is unconfigured → falls back to latest order) */
  buyers?: number
}

// ---- Local follows and bookmarks (meta, browser-level preferences, not account-scoped) ----

export const listPublisherFollows = async (): Promise<string[]> => (await getMeta<string[]>('publisherFollows')) ?? []

export const followPublisher = async (address: string): Promise<void> => {
  const a = address.toLowerCase()
  const cur = await listPublisherFollows()
  if (!cur.includes(a)) await putMeta('publisherFollows', [...cur, a])
}

export const unfollowPublisher = async (address: string): Promise<void> => {
  const a = address.toLowerCase()
  await putMeta('publisherFollows', (await listPublisherFollows()).filter((x) => x !== a))
}

export interface BookmarkRecord {
  manifestCid: string
  seller: string
  /** 0x-prefixed 32-byte hex (K is publicly disclosed with the Published event; keeping it locally adds no exposure) */
  key: string
  plainSha256: string
  plainSize: bigint
  manifestHeightHint: bigint
  /** Backfilled after the first successful download (events carry no file name) */
  name?: string
  savedAt: number
}

export const listBookmarks = async (): Promise<BookmarkRecord[]> => (await getMeta<BookmarkRecord[]>('publicBookmarks')) ?? []

export const isBookmarked = async (manifestCid: string): Promise<boolean> =>
  (await listBookmarks()).some((b) => b.manifestCid === manifestCid)

export async function addBookmark(item: Omit<BookmarkRecord, 'savedAt'>): Promise<void> {
  const list = await listBookmarks()
  if (list.some((b) => b.manifestCid === item.manifestCid)) return
  await putMeta('publicBookmarks', [{ ...item, savedAt: Date.now() }, ...list])
}

export const removeBookmark = async (manifestCid: string): Promise<void> =>
  putMeta('publicBookmarks', (await listBookmarks()).filter((b) => b.manifestCid !== manifestCid))

export const setBookmarkName = async (manifestCid: string, name: string): Promise<void> =>
  putMeta(
    'publicBookmarks',
    (await listBookmarks()).map((b) => (b.manifestCid === manifestCid ? { ...b, name } : b)),
  )

// ---- Feed assembly (pure functions) ----

export interface DiscoverFeeds {
  /** Block height descending (same-manifestCid dedupe keeps the newest) */
  latest: DiscoverItem[]
  /** Buyer count descending, falls back to latest order without buyer data */
  hot: DiscoverItem[]
  /** Followed publishers (a subset of latest) */
  followed: DiscoverItem[]
}

export function buildDiscoverFeeds(events: DiscoverItem[], follows: string[]): DiscoverFeeds {
  // Multiple publishes of the same manifestCid (idempotent resend / re-publish
  // at a new price) → keep the one with the highest block
  const byCid = new Map<string, DiscoverItem>()
  for (const e of events) {
    const cur = byCid.get(e.manifestCid)
    if (!cur || e.blockNumber >= cur.blockNumber) byCid.set(e.manifestCid, e)
  }
  const latest = [...byCid.values()].sort((a, b) => b.blockNumber - a.blockNumber)
  const followSet = new Set(follows.map((a) => a.toLowerCase()))
  const followed = latest.filter((e) => followSet.has(e.seller.toLowerCase()))
  const hot = [...latest].sort((a, b) => (b.buyers ?? 0) - (a.buyers ?? 0) || b.blockNumber - a.blockNumber)
  return { latest, hot, followed }
}

export interface DiscoverDeps {
  fetchEvents: () => Promise<PublishedEvent[]>
  /** fileKey (lowercased) → unique buyer count; return an empty Map on failure/unconfigured (falls back to latest order) */
  fetchBuyers: () => Promise<Map<string, number>>
  listFollows: () => Promise<string[]>
}

export async function loadDiscoverFeeds(deps: DiscoverDeps): Promise<DiscoverFeeds> {
  const [events, follows] = await Promise.all([deps.fetchEvents(), deps.listFollows()])
  const buyers = await deps.fetchBuyers().catch(() => new Map<string, number>())
  const enriched: DiscoverItem[] = events.map((e) => ({ ...e, buyers: buyers.get(e.fileKey.toLowerCase()) }))
  return buildDiscoverFeeds(enriched, follows)
}
