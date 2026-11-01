// Offline tests for the Discover feed assembly (2026-11-01): same-CID dedupe keeps
// the newest event, latest/hot/followed ordering, buyer-count enrichment with a
// graceful fallback when aggregation fails, and the local follows/bookmarks
// (meta) roundtrip. fake IndexedDB + injected deps — no network, no cost.
//   node discover-feed-test.mjs

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

const { buildDiscoverFeeds, loadDiscoverFeeds, listPublisherFollows, followPublisher, unfollowPublisher, listBookmarks, addBookmark, removeBookmark, isBookmarked, setBookmarkName } = await import('../../frontend/src/lib/discover.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// PublishedEvent-shaped fixture (fields used by the assembler only)
const ev = (manifestCid, blockNumber, seller = '0xaaa', fileKey = '0xfk', buyers) => ({
  manifestCid,
  blockNumber,
  seller,
  fileKey,
  key: '0x' + '11'.repeat(32),
  plainSha256: 'ab'.repeat(32),
  plainSize: 100n,
  manifestHeightHint: 5000n + BigInt(blockNumber % 100),
  txHash: '0x' + '22'.repeat(32),
  buyers,
})
const cids = (rows) => rows.map((r) => r.manifestCid).join(',')

// ---- 1. dedupe: same manifestCid keeps the newest block ----
{
  const feeds = buildDiscoverFeeds([ev('cid-a', 100), ev('cid-a', 200), ev('cid-b', 150)], [])
  ok(cids(feeds.latest) === 'cid-a,cid-b', '1 dedupe keeps newest event per manifestCid')
  ok(feeds.latest[0].blockNumber === 200, '1 latest sorted by block desc')
}

// ---- 2. hot: buyers desc, missing buyers last, tie → block desc ----
{
  const feeds = buildDiscoverFeeds([ev('cid-a', 100, '0xaaa', '0xfka', 2), ev('cid-b', 500, '0xaaa', '0xfkb', 5), ev('cid-c', 400, '0xaaa', '0xfkc'), ev('cid-d', 300, '0xaaa', '0xfkd', 2)], [])
  ok(cids(feeds.hot) === 'cid-b,cid-d,cid-a,cid-c', '2 hot sorts by buyers desc then block desc, undefined last')
}

// ---- 3. followed: case-insensitive seller filter over latest ----
{
  const feeds = buildDiscoverFeeds([ev('cid-a', 100, '0xAAA'), ev('cid-b', 200, '0xbbb')], ['0xaaa'])
  ok(cids(feeds.followed) === 'cid-a', '3 followed filters by seller (case-insensitive)')
}

// ---- 4. loadDiscoverFeeds: enrichment + failure fallback ----
{
  const feeds = await loadDiscoverFeeds({
    fetchEvents: async () => [ev('cid-a', 100, '0xaaa', '0xFKA'), ev('cid-b', 200, '0xbbb', '0xfkb')],
    fetchBuyers: async () => new Map([['0xfka', 7]]),
    listFollows: async () => [],
  })
  const a = feeds.latest.find((x) => x.manifestCid === 'cid-a')
  const b = feeds.latest.find((x) => x.manifestCid === 'cid-b')
  ok(a.buyers === 7 && b.buyers === undefined, '4 buyers enriched by fileKey (case-insensitive lookup)')
}
{
  const feeds = await loadDiscoverFeeds({
    fetchEvents: async () => [ev('cid-a', 100, '0xaaa', '0xfka'), ev('cid-b', 200, '0xbbb', '0xfkb')],
    fetchBuyers: async () => {
      throw new Error('aggregation boom')
    },
    listFollows: async () => [],
  })
  ok(cids(feeds.hot) === 'cid-b,cid-a', '4 aggregation failure falls back to latest order (no throw)')
}
{
  const feeds = await loadDiscoverFeeds({
    fetchEvents: async () => [ev('cid-a', 100, '0xaaa', '0xfka')],
    fetchBuyers: async () => new Map(),
    listFollows: async () => ['0xaaa'],
  })
  ok(cids(feeds.followed) === 'cid-a', '4 follows from deps filter the followed feed')
}

// ---- 5. follows roundtrip (meta): dedupe + unfollow ----
{
  await followPublisher('0xAAA')
  await followPublisher('0xaaa')
  await followPublisher('0xbbb')
  ok((await listPublisherFollows()).join(',') === '0xaaa,0xbbb', '5 follow dedupes and lowercases')
  await unfollowPublisher('0xAAA')
  ok((await listPublisherFollows()).join(',') === '0xbbb', '5 unfollow is case-insensitive')
}

// ---- 6. bookmarks roundtrip (meta): idempotent add, name backfill, remove ----
{
  const item = { manifestCid: 'cid-x', seller: '0xaaa', key: '0x' + '11'.repeat(32), plainSha256: 'ab'.repeat(32), plainSize: 1n, manifestHeightHint: 42n }
  await addBookmark(item)
  await addBookmark(item)
  ok((await listBookmarks()).length === 1 && (await isBookmarked('cid-x')), '6 addBookmark is idempotent')
  await addBookmark({ ...item, manifestCid: 'cid-y' })
  await setBookmarkName('cid-x', 'report.pdf')
  const bx = (await listBookmarks()).find((b) => b.manifestCid === 'cid-x')
  ok(bx?.name === 'report.pdf' && typeof bx.savedAt === 'number', '6 name backfilled, savedAt stamped')
  await removeBookmark('cid-x')
  ok(!(await isBookmarked('cid-x')) && (await listBookmarks()).length === 1, '6 remove deletes exactly one')
}

console.log(`\n${passed} assertions passed`)
if (process.exitCode) console.error('FAILED')
