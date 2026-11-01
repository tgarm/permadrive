// Discover: the browse surface for public files — the PublicPublisher's
// Published events are the network-wide public index (K is disclosed with the
// event; the D10 trust domain is unchanged and the download path always
// verifies, D11). Four discovery modes share one full scan: Latest (block
// descending) / Hot (unique buyer count descending) / Followed publishers
// (filtered by a local address list) / Saved (local bookmarks: locator + K,
// re-downloadable). No wallet required: read-only public clients (EVM
// getLogs) plus a lazy consensus connect for downloads — same policy as the
// Share landing page (public content must be downloadable without a wallet).

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { formatBytes, fromHex } from '../lib/bytes'
import {
  listPublishedEvents,
  publicPublisherActive,
} from '../lib/publicPublisher'
import { fetchBuyerCountsByFileKey, salesActive } from '../lib/sales'
import {
  addBookmark,
  followPublisher,
  isBookmarked,
  listBookmarks,
  listPublisherFollows,
  loadDiscoverFeeds,
  removeBookmark,
  setBookmarkName,
  unfollowPublisher,
  type BookmarkRecord,
  type DiscoverFeeds,
} from '../lib/discover'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { decryptAndSavePublic } from '../lib/publicDownload'
import { useI18n } from '../i18n'

type Feed = 'latest' | 'hot' | 'followed' | 'saved'

const short = (a: string): string => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')

/** Download input: an event row or a bookmark row share this shape (locator + K + public declaration) */
interface Downloadable {
  manifestCid: string
  key: string
  plainSha256: string
  plainSize: bigint
  manifestHeightHint: bigint
}

export function DiscoverPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const [feed, setFeed] = useState<Feed>('latest')
  const [feeds, setFeeds] = useState<DiscoverFeeds | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [follows, setFollows] = useState<string[]>([])
  const [busyCid, setBusyCid] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      if (!publicPublisherActive()) {
        setError(t('errors.publicPublisherNotConfigured'))
        return
      }
      setFeeds(
        await loadDiscoverFeeds({
          fetchEvents: listPublishedEvents,
          fetchBuyers: async () => {
            if (!salesActive()) return new Map<string, number>()
            const sets = await fetchBuyerCountsByFileKey()
            return new Map([...sets].map(([k, v]) => [k.toLowerCase(), v.size]))
          },
          listFollows: listPublisherFollows,
        }),
      )
      setBookmarks(await listBookmarks())
      setFollows(await listPublisherFollows())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  const download = async (item: Downloadable) => {
    setBusyCid(item.manifestCid)
    setNotice(null)
    const say = (s: string) => setNotice(s)
    try {
      const api = await connect()
      const manifest = await recoverManifestFromHint(api, item.manifestCid, Number(item.manifestHeightHint))
      await decryptAndSavePublic(api, manifest, fromHex(item.key), say, item)
      // backfill the file name after the first successful download (events and bookmarks carry no name)
      await setBookmarkName(item.manifestCid, manifest.file.name)
      setBookmarks(await listBookmarks())
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusyCid(null)
    }
  }

  const toggleBookmark = async (item: Downloadable & { seller: string }) => {
    if (await isBookmarked(item.manifestCid)) await removeBookmark(item.manifestCid)
    else
      await addBookmark({
        manifestCid: item.manifestCid,
        seller: item.seller,
        key: item.key,
        plainSha256: item.plainSha256,
        plainSize: item.plainSize,
        manifestHeightHint: item.manifestHeightHint,
      })
    setBookmarks(await listBookmarks())
  }

  const toggleFollow = async (seller: string) => {
    if (follows.includes(seller.toLowerCase())) await unfollowPublisher(seller)
    else await followPublisher(seller)
    setFollows(await listPublisherFollows())
    await reload() // refresh the "Followed publishers" feed after follow/unfollow
  }

  const savedAsDownloadable = (b: BookmarkRecord): Downloadable => ({
    manifestCid: b.manifestCid,
    key: b.key,
    plainSha256: b.plainSha256,
    plainSize: b.plainSize,
    manifestHeightHint: b.manifestHeightHint,
  })

  const rows: (Downloadable & { label: string; seller: string; blockNumber?: number; buyers?: number })[] =
    feed === 'saved'
      ? bookmarks.map((b) => ({ ...savedAsDownloadable(b), label: b.name ?? short(b.manifestCid), seller: b.seller }))
      : (feeds
          ? feed === 'latest'
            ? feeds.latest
            : feed === 'hot'
              ? feeds.hot
              : feeds.followed
          : []
        ).map((x) => ({ ...x, label: short(x.manifestCid) }))

  const bookmarked = new Set(bookmarks.map((b) => b.manifestCid))

  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h2>{t('discover.title')}</h2>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => void reload()}>{t('discover.refresh')}</button>
          </div>
        </div>
        <p className="privacy-note">
          {t('discover.subtitle')}
          {follows.length > 0 && <span>{' · '}{t('discover.followingCount', [follows.length])}</span>}
        </p>
        <div className="row">
          {(['latest', 'hot', 'followed', 'saved'] as Feed[]).map((f) => (
            <button key={f} className={feed === f ? 'btn small' : 'btn ghost small'} onClick={() => setFeed(f)}>
              {t(`discover.feed.${f}`)}
              {f === 'saved' && bookmarks.length > 0 ? ` (${bookmarks.length})` : ''}
            </button>
          ))}
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        {!error && feeds == null && feed !== 'saved' && <p className="muted" role="status">{t('discover.loading')}</p>}
        {/* the empty state only shows once the scan settled (saved is a purely
            local feed with no scan state) — avoids "scanning" and "nothing yet"
            rendering together */}
        {rows.length === 0 && !error && (feed === 'saved' || feeds != null) && <p className="muted">{t(`discover.empty.${feed}`)}</p>}
        {rows.length > 0 && (
          <table className="files-table">
            <thead>
              <tr>
                <th>{t('files.thFile')}</th>
                <th>{t('common.size')}</th>
                {feed !== 'saved' && <th>{t('discover.blockHeight')}</th>}
                {feed !== 'saved' && feed !== 'followed' && <th>{t('discover.publisher')}</th>}
                {feed === 'hot' && <th>{t('discover.buyers')}</th>}
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${feed}-${r.manifestCid}`}>
                  <td>
                    <div className="file-name">🌐 {r.label}</div>
                    {feed === 'saved' && <div className="mono small-text muted">{short(r.manifestCid)}</div>}
                  </td>
                  <td>{formatBytes(Number(r.plainSize))}</td>
                  {feed !== 'saved' && <td className="mono small-text">#{r.blockNumber}</td>}
                  {feed !== 'saved' && feed !== 'followed' && (
                    <td>
                      <span className="mono small-text">{short(r.seller)}</span>{' '}
                      <button className="btn ghost small" onClick={() => void toggleFollow(r.seller)}>
                        {follows.includes(r.seller.toLowerCase()) ? t('discover.unfollow') : t('discover.follow')}
                      </button>
                    </td>
                  )}
                  {feed === 'hot' && <td>{r.buyers ?? 0}</td>}
                  <td>
                    <div className="row-actions">
                      <button className="btn small" disabled={busyCid === r.manifestCid} onClick={() => void download(r)}>
                        {busyCid === r.manifestCid ? t('discover.downloading') : t('common.download')}
                      </button>
                      {feed === 'saved' ? (
                        <button className="btn ghost small" onClick={() => void removeBookmark(r.manifestCid).then(() => listBookmarks()).then(setBookmarks)}>
                          {t('discover.unbookmark')}
                        </button>
                      ) : (
                        <button className="btn ghost small" onClick={() => void toggleBookmark(r)}>
                          {bookmarked.has(r.manifestCid) ? t('discover.unbookmark') : t('discover.bookmark')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {notice && <div className="notice">{notice}</div>}
        <p className="muted small-text">{t('discover.footer')}</p>
      </section>
    </div>
  )
}
