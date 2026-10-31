// Direct-sales section (phase-one UI): seller (list / reprice = new revision /
// deliver pending orders) + buyer (browse a directory / pay directly /
// decrypt-download / rate up or down). Payment splits instantly, no platform
// refunds, no escrow, no withdrawal — mounted on FilesPage, rendered only once
// config.salesAddress is configured (the paid-download escrow frontend was
// removed entirely on 2026-10-31). Delivery is semi-automatic: with the
// seller's app online they click Deliver on a pending order — unwrap K →
// pdgrant v3 private message (over the Mailbox E2E channel) → markKeySent
// (optional registration; never blocks the buyer's download). Ratings need no
// delivery precondition (an undelivered buyer may rate negatively); a vote
// change subtracts before it adds; on-chain rating costs gas, explained in a
// confirm dialog up front.
//
// Wallet-dialog transparency (same policy as the first wallet-dialog batch):
// the purchase confirm states "no platform refunds + the seller must be online
// + Auto-EVM gas"; a two-step receiving precheck — (1) a read-only zero-popup
// on-chain key check guiding enabling message receiving first, (2) a
// receive-capability comparison (this wallet's encryption key vs the announced
// one, guarding against a switched wallet implementation that could pay
// without being able to receive the delivery; local derives with zero popups,
// injected prompts once after the user confirms). Prices display in AI3 and go
// on-chain in wei. Rating/directory data is always cached per seller scope
// (same CID across sellers must never mix; unloaded/failed never masquerades
// as "no ratings").

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3, formatBytes } from '../lib/bytes'
import { autoEvmChain } from '../lib/evm'
import { ChainTag } from '../components/ChainTag'
import { decryptMessage, encryptionPublicKeyFor, getAnnouncedKey, mailboxAddress, syncMessages } from '../lib/mailbox'
import { unwrapManifestKey } from '../lib/keyUnwrap'
import {
  deliverKeySales,
  delistSales,
  fetchMyOrdersSales,
  fetchSellerOrdersSales,
  getListingSales,
  getRatingSales,
  getVoteSales,
  isPdGrantV3,
  purchaseQuote,
  purchaseSalesWithQuote,
  rateSales,
  salesActive,
  salesAddress,
  unwrapDeliveredKeySales,
  createRevisionSales,
  type SalesOrderRow,
} from '../lib/sales'
import { fetchEntries, type RegistryEntry } from '../lib/registry'
import { getManifest, listMessages, listRegistryRecords } from '../lib/store'
import { retrieveFile } from '../lib/retrieve'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { aesGcmDecrypt } from '../lib/vaultCrypto'
import { fromHex, sha256Hex } from '../lib/bytes'
import { saveBlob } from '../lib/download'
import { useI18n } from '../i18n'

const short = (a: string): string => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// Rating/vote cache keys: must include the seller (the same CID across
// different sellers must never mix ratings)
const ratingKey = (seller: string, cid: string) => `${seller.toLowerCase()}:${cid}`

type RatingState = { status: 'ok' | 'failed'; up: bigint; down: bigint; buyers: bigint }

const ratingFailedState = (): RatingState => ({ status: 'failed', up: 0n, down: 0n, buyers: 0n })

/** Single rating read (failure gets its own state — a network error is never
 *  passed off as "no ratings") */
async function loadRating(seller: string, cid: string): Promise<RatingState> {
  try {
    const r = await getRatingSales(seller, cid)
    return { status: 'ok', ...r }
  } catch {
    return ratingFailedState()
  }
}

export function SalesSection({ getPassphrase, onNotice }: { getPassphrase: () => Promise<string | null>; onNotice?: (s: string) => void }) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()

  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [listings, setListings] = useState<Map<string, { price: bigint; revision: bigint } | null>>(new Map())
  const [ratings, setRatings] = useState<Map<string, RatingState>>(new Map()) // ratingKey(seller,cid) → stateful rating
  const [pending, setPending] = useState<SalesOrderRow[]>([])
  const [orders, setOrders] = useState<SalesOrderRow[]>([])
  const [votes, setVotes] = useState<Map<string, number>>(new Map()) // ratingKey(seller,cid) → current vote
  const [priceEntry, setPriceEntry] = useState('')
  const [priceValue, setPriceValue] = useState('')
  const [viewAddr, setViewAddr] = useState('')
  const [viewRows, setViewRows] = useState<{ entry: RegistryEntry; listing: Awaited<ReturnType<typeof getListingSales>>; rating: RatingState | null }[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const say = useCallback((s: string) => { setNotice(s); onNotice?.(s) }, [onNotice])

  const reload = useCallback(async () => {
    if (!evm || !salesActive()) return
    const myEntries = await fetchEntries(evm.address)
    setEntries(myEntries)
    const lmap = new Map<string, { price: bigint; revision: bigint } | null>()
    const rmap = new Map<string, RatingState>()
    const vmap = new Map<string, number>()
    for (const e of myEntries) {
      const l = await getListingSales(evm.address, e.manifestCid)
      lmap.set(e.manifestCid, l ? { price: l.price, revision: l.revision } : null)
      rmap.set(ratingKey(evm.address, e.manifestCid), await loadRating(evm.address, e.manifestCid))
    }
    setListings(lmap)
    setRatings(rmap)
    // pending deliveries (Paid) and my purchases (all)
    setPending(await fetchSellerOrdersSales(evm.address))
    const rows = await fetchMyOrdersSales(evm.address)
    setOrders(rows)
    for (const row of rows) {
      if (!row.entry) continue
      const k = ratingKey(row.seller, row.entry.manifestCid)
      if (!vmap.has(k)) vmap.set(k, await getVoteSales(row.seller, row.entry.manifestCid, evm.address))
    }
    setVotes(vmap)
  }, [evm])

  useEffect(() => {
    void reload().catch((e) => say(t('errors.registryTxFailed', ['read', (e as Error).message])))
  }, [reload])

  // ---- seller ----

  const listNow = async () => {
    if (!evm || !priceEntry || !priceValue) return
    const wei = BigInt(Math.round(Number(priceValue) * 1e18))
    if (wei <= 0n) return
    setBusy(true)
    try {
      await createRevisionSales(evm, priceEntry, wei)
      say(t('sales.listedOk', [priceValue]))
      setPriceEntry('')
      setPriceValue('')
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const unlist = async (entry: RegistryEntry) => {
    if (!evm) return
    setBusy(true)
    try {
      await delistSales(evm, entry.manifestCid)
      say(t('sales.unlistedOk', [entry.name]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const deliver = async (row: SalesOrderRow) => {
    if (!evm || !row.entry) return
    setBusy(true)
    try {
      say(t('sales.delivering', [short(row.buyer)]))
      // manifest prefers the local copy (the seller's own file is usually in the library), otherwise recover from the Registry height hint
      const rec = (await listRegistryRecords()).find((r) => r.manifestCid === row.entry!.manifestCid)
      let manifest = rec ? await getManifest(rec.rootCid) : undefined
      const api = await connect()
      manifest ??= await recoverManifestFromHint(api, row.entry.manifestCid, Number(row.entry.height))
      const r = await deliverKeySales(evm, row.entry.manifestCid, manifest, row.buyer, row.orderId, row.provider, getPassphrase)
      say(t('sales.deliveredOk', [short(row.buyer), r.deliveredTxHash.slice(0, 14) + '…']))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // ---- buyer ----

  const viewDirectory = async () => {
    if (!viewAddr.trim()) return
    setBusy(true)
    try {
      const seller = viewAddr.trim()
      const rows = await fetchEntries(seller)
      // Ratings load together with the listing (into the ViewRow): browsing
      // someone else's directory loads their ratings too; failure gets its own
      // state — never "unloaded masquerading as no ratings", never a crash
      const out: { entry: RegistryEntry; listing: Awaited<ReturnType<typeof getListingSales>>; rating: RatingState | null }[] = []
      for (const entry of rows) {
        out.push({
          entry,
          listing: await getListingSales(seller, entry.manifestCid),
          rating: await loadRating(seller, entry.manifestCid),
        })
      }
      setViewRows(out)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const buy = async (entry: RegistryEntry, seller: string) => {
    if (!evm) return
    setBusy(true)
    try {
      // receiving precheck step 1 (read-only, zero popups): without an announced
      // key the seller cannot encrypt the delivery
      const announced = await getAnnouncedKey(evm.address)
      if (!announced) {
        say(t('sales.enableReceivingFirst'))
        return
      }
      // fresh quote (the price in viewRows may be stale after a reprice/revision swap)
      const quote = await purchaseQuote(seller, entry.manifestCid)
      if (!quote) {
        say(t('sales.notListed'))
        return
      }
      // pre-payment confirm: direct sales has no platform refunds + the seller must be online to deliver
      if (!window.confirm(t('sales.buyConfirm', [formatAi3(quote.price)]))) return
      // receiving precheck step 2: a non-empty on-chain key does not prove this
      // wallet can decrypt it — with the same address under a switched wallet
      // implementation, the announced key may not match this wallet's
      // derivation and the paid delivery would be unreceivable. local derives
      // with zero popups; injected fetches the encryption key (one prompt after
      // the user confirmed = a user-authorized small round trip)
      const currentKey = await encryptionPublicKeyFor(evm)
      if (currentKey !== announced) {
        say(t('sales.receiveKeyMismatch'))
        return
      }
      await purchaseSalesWithQuote(evm, quote)
      say(t('sales.purchasedOk', [entry.name, formatAi3(quote.price)]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // pdgrant v3 strict match: message chain/contract domains + the grant's
  // chainId/sales/orderId/buyer/seller/provider all checked against the order
  // snapshot — a same-orderId grant from a different sales instance can never
  // be misused; wrong candidates are isolated and tried one by one
  const findGrant = async (row: SalesOrderRow): Promise<Uint8Array | null> => {
    if (!evm || !row.entry) return null
    const me = evm.address.toLowerCase()
    const sales = salesAddress()?.toLowerCase()
    if (!sales) return null
    const mailbox = mailboxAddress().toLowerCase()
    const expectedProvider = row.provider && row.provider !== ZERO_ADDR ? row.provider.toLowerCase() : null
    const msgs = await listMessages()
    const candidates = []
    for (const m of msgs) {
      if (!m.plain) continue
      if (m.to && m.to.toLowerCase() !== me) continue
      if (m.chainId != null && m.chainId !== autoEvmChain.id) continue // message chain domain
      if (!m.id.toLowerCase().startsWith(`${mailbox}:`)) continue // message contract domain (id = `${contract}:${eventId}:${txHash}`)
      if (m.from.toLowerCase() !== row.seller && (!expectedProvider || m.from.toLowerCase() !== expectedProvider)) continue
      const g = isPdGrantV3(m.plain)
      if (!g || g.manifestCid !== row.entry.manifestCid) continue
      if (g.chainId !== autoEvmChain.id) continue // grant chain domain
      if (g.sales.toLowerCase() !== sales) continue // grant sales-contract domain
      if (g.orderId !== row.orderId.toString() || g.buyer?.toLowerCase() !== me || g.seller?.toLowerCase() !== row.seller) continue
      // provider domain: an order with a service requires the same provider on
      // the grant; a service-less order rejects any non-zero provider
      if (expectedProvider ? g.provider?.toLowerCase() !== expectedProvider : !!g.provider && g.provider.toLowerCase() !== ZERO_ADDR) continue
      candidates.push(g)
    }
    for (const g of candidates) {
      try {
        return await unwrapDeliveredKeySales(evm, g)
      } catch {
        // wrong candidate isolated: try the next one
      }
    }
    return null
  }

  /** Inbox sync + targeted decryption: an explicit entry point on the orders
   *  section (no detour through the Messages page); only the current order's
   *  counterparties' messages are decrypted, keeping prompts minimal */
  const syncAndDecryptFor = async (rows: SalesOrderRow[]) => {
    if (!evm) return
    const me = evm.address.toLowerCase()
    say(t('sales.syncingInbox'))
    await syncMessages(evm.address, evm)
    const counterparts = new Set<string>()
    for (const r of rows) {
      counterparts.add(r.seller)
      if (r.provider && r.provider !== ZERO_ADDR) counterparts.add(r.provider)
    }
    const pendingMsgs = (await listMessages()).filter(
      (m) => !m.plain && m.decryptStatus !== 'ok' && m.to?.toLowerCase() === me && counterparts.has(m.from.toLowerCase()),
    )
    for (const m of pendingMsgs) {
      try {
        await decryptMessage(evm, m) // per-message failure isolation
      } catch {
        /* undecryptable (e.g. old ciphertext from another chain) stays as-is */
      }
    }
  }

  const downloadPurchased = async (row: SalesOrderRow) => {
    if (!evm || !row.entry) return
    setBusy(true)
    try {
      let keyBytes = await findGrant(row)
      if (!keyBytes) {
        // no locally decrypted pdgrant: sync + targeted decrypt proactively and
        // look again (a user-clicked entry point; injected decrypt prompts are
        // user-authorized)
        try {
          await syncAndDecryptFor([row])
          keyBytes = await findGrant(row)
        } catch {
          /* sync failure counts as not-yet-delivered; the wait hint below covers it */
        }
      }
      if (!keyBytes) {
        // no pdgrant yet (a self-purchase skips the channel, or the seller has not
        // responded) — if this machine already holds the file, unwrap K directly
        const rec = (await listRegistryRecords()).find((r) => r.manifestCid === row.entry!.manifestCid)
        const localManifest = rec ? await getManifest(rec.rootCid) : undefined
        if (localManifest?.encryption) {
          const k = await unwrapManifestKey(evm, localManifest, getPassphrase)
          await finishDownload(localManifest, k)
          return
        }
        say(t('sales.waitingDelivery'))
        return
      }
      const api = await connect()
      const manifest = await recoverManifestFromHint(api, row.entry.manifestCid, Number(row.entry.height))
      await finishDownload(manifest, keyBytes)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const finishDownload = async (manifest: Awaited<ReturnType<typeof recoverManifestFromHint>>, keyBytes: Uint8Array) => {
    if (!manifest.encryption) throw new Error(t('errors.manifestNotEncrypted'))
    say(t('sales.decryptingPurchased'))
    const result = await retrieveFile(await connect(), manifest)
    if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
    const plain = await aesGcmDecrypt(keyBytes, fromHex(manifest.encryption!.iv), result.bytes)
    const plainSha = await sha256Hex(plain)
    if (plainSha !== manifest.file.sha256) throw new Error(t('files.sha256Mismatch', [plainSha]))
    saveBlob(plain, manifest.file.name, manifest.file.mimeType)
    say(t('sales.decryptedOk', [manifest.file.name, plainSha.slice(0, 16)]))
    await reload()
  }

  // rate / change vote: no delivery precondition (an undelivered buyer may rate
  // negatively); Auto-EVM gas stated up front; clicking the same vote again
  // explains itself (contract-idempotent no-op; service attribution stays with
  // the original order and does not migrate to a newer one)
  const vote = async (row: SalesOrderRow, positive: boolean) => {
    if (!evm || !row.entry) return
    const k = ratingKey(row.seller, row.entry.manifestCid)
    const current = votes.get(k) ?? 0
    if ((positive && current === 1) || (!positive && current === -1)) {
      say(t('sales.rateNoOp'))
      return
    }
    if (!window.confirm(t('sales.rateConfirm'))) return
    setBusy(true)
    try {
      await rateSales(evm, row.orderId, positive)
      say(t('sales.ratedOk', [positive ? t('sales.rateUp') : t('sales.rateDown')]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // manual inbox entry point: one click on the orders section to sync +
  // targeted decrypt, no detour through the Messages page
  const syncInbox = async () => {
    if (!evm) return
    setBusy(true)
    try {
      await syncAndDecryptFor(orders)
      say(t('sales.inboxSynced'))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const myActiveListings = entries.filter((e) => (listings.get(e.manifestCid)?.price ?? 0n) > 0n)

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('sales.title')}</h2>
      </div>
      <p className="privacy-note">
        <ChainTag chain="evm" /> {t('sales.notice')}
      </p>
      {notice && <div className="notice">{notice}</div>}
      {!evm && <div className="notice">{t('sales.connectFirst')}</div>}

      {evm && (
        <div className="sales-grid">
          {/* seller */}
          <div className="sales-col">
            <h3>{t('sales.myListings')}</h3>
            <div className="msg-compose">
              <div className="kv">
                <span>{t('sales.selectEntry')}</span>
                <select value={priceEntry} onChange={(e) => setPriceEntry(e.target.value)}>
                  <option value="">—</option>
                  {entries.map((e) => (
                    <option key={e.manifestCid} value={e.manifestCid}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="kv">
                <span>{t('sales.priceLabel')}</span>
                <input type="number" min="0" step="0.001" placeholder="0.05" value={priceValue} onChange={(e) => setPriceValue(e.target.value)} />
              </div>
              {priceValue && Number(priceValue) > 0 && (
                <p className="muted small-text">
                  {t('sales.netPreview', ['10', formatAi3((BigInt(Math.round(Number(priceValue) * 1e18)) * 9n) / 10n)])}
                </p>
              )}
              <div className="row">
                <button className="btn small primary" disabled={busy || !priceEntry || !priceValue} onClick={() => void listNow()}>
                  {t('sales.listBtn')}
                </button>
              </div>
              <p className="muted small-text">{t('sales.selectHint')}</p>
            </div>
            {myActiveListings.length > 0 && (
              <table className="files-table">
                <tbody>
                  {myActiveListings.map((e) => {
                    const r = evm ? ratings.get(ratingKey(evm.address, e.manifestCid)) : undefined
                    return (
                      <tr key={e.manifestCid}>
                        <td>
                          <div>{e.name}</div>
                          <div className="muted small-text">
                            {r?.status === 'ok' && (r.up > 0n || r.down > 0n)
                              ? t('sales.ratingLine', [r.up.toString(), r.down.toString(), r.buyers.toString()])
                              : r?.status === 'failed'
                                ? t('sales.ratingFailed')
                                : t('sales.noRatings')}
                          </div>
                        </td>
                        <td>{formatAi3(listings.get(e.manifestCid)!.price)} AI3</td>
                        <td>
                          <button className="btn ghost small" disabled={busy} onClick={() => void unlist(e)}>
                            {t('sales.unlistBtn')}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            <h3>{t('sales.pendingOrders')}</h3>
            {pending.length === 0 ? (
              <p className="muted small-text">{t('sales.pendingEmpty')}</p>
            ) : (
              <table className="files-table">
                <tbody>
                  {pending.map((row) => (
                    <tr key={`s-${row.orderId}`}>
                      <td>
                        <div>{row.entry?.name ?? '?'}</div>
                        <div className="mono small-text muted">{short(row.buyer)}</div>
                      </td>
                      <td>{formatAi3(row.price)} AI3</td>
                      <td>
                        <button className="btn small primary" disabled={busy} onClick={() => void deliver(row)}>
                          {t('sales.deliver')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* buyer */}
          <div className="sales-col">
            <h3>{t('sales.viewDirectory')}</h3>
            <div className="kv">
              <span>{t('sales.addressLabel')}</span>
              <input className="mono" placeholder="0x…" value={viewAddr} onChange={(e) => setViewAddr(e.target.value)} />
            </div>
            <div className="row">
              <button className="btn small" disabled={busy || !viewAddr.trim()} onClick={() => void viewDirectory()}>
                {t('sales.view')}
              </button>
            </div>
            {viewRows && (
              viewRows.length === 0 ? (
                <p className="muted small-text">{t('sales.viewEmpty')}</p>
              ) : (
                <table className="files-table">
                  <tbody>
                    {viewRows.map(({ entry, listing, rating }) => {
                      // ratings ride with the ViewRow: no listing → no rating
                      // segment; failure gets its own state; ok-and-zero = no
                      // ratings. No non-null assertions anywhere.
                      const ratingSeg = !listing
                        ? ''
                        : rating?.status === 'failed'
                          ? ' · ' + t('sales.ratingFailed')
                          : rating?.status === 'ok' && (rating.up > 0n || rating.down > 0n)
                            ? ' · ' + t('sales.ratingLine', [rating.up.toString(), rating.down.toString(), rating.buyers.toString()])
                            : rating?.status === 'ok'
                              ? ' · ' + t('sales.noRatings')
                              : ''
                      return (
                        <tr key={entry.manifestCid}>
                          <td>
                            <div>{entry.name}</div>
                            <div className="muted small-text">
                              {formatBytes(Number(entry.size))}
                              {ratingSeg}
                            </div>
                          </td>
                          <td>
                            {listing && !listing.revoked ? (
                              <button
                                className="btn small primary"
                                disabled={busy}
                                onClick={() => void buy(entry, listing.seller)}
                              >
                                {t('sales.buy')} · {formatAi3(listing.price)} AI3
                              </button>
                            ) : (
                              <span className="muted small-text">{t('sales.notListed')}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            )}

            <div className="card-head" style={{ marginTop: 8 }}>
              <h3>{t('sales.myOrders')}</h3>
              {orders.length > 0 && (
                <button className="btn ghost small" disabled={busy} title={t('sales.syncInboxHint')} onClick={() => void syncInbox()}>
                  {t('sales.syncInbox')}
                </button>
              )}
            </div>
            {orders.length === 0 ? (
              <p className="muted small-text">{t('sales.ordersEmpty')}</p>
            ) : (
              <table className="files-table">
                <tbody>
                  {orders.map((row) => {
                    const myVote = row.entry ? (votes.get(ratingKey(row.seller, row.entry.manifestCid)) ?? 0) : 0
                    return (
                      <tr key={`o-${row.orderId}`}>
                        <td>
                          <div>{row.entry?.name ?? `order #${row.orderId}`}</div>
                          <div className="muted small-text">
                            {t(`sales.state.${row.state === 1 ? 'keySent' : 'paid'}`)} · {formatAi3(row.price)} AI3 · {short(row.seller)}
                          </div>
                        </td>
                        <td>
                          {row.entry && (
                            <button className="btn small" disabled={busy} onClick={() => void downloadPurchased(row)}>
                              {t('sales.downloadPurchased')}
                            </button>
                          )}{' '}
                          {row.entry && (
                            <>
                              <button
                                className="btn ghost small"
                                disabled={busy}
                                title={t('sales.rateConfirm')}
                                style={myVote === 1 ? { fontWeight: 700 } : undefined}
                                onClick={() => void vote(row, true)}
                              >
                                👍 {t('sales.rateUp')}
                              </button>{' '}
                              <button
                                className="btn ghost small"
                                disabled={busy}
                                title={t('sales.rateConfirm')}
                                style={myVote === -1 ? { fontWeight: 700 } : undefined}
                                onClick={() => void vote(row, false)}
                              >
                                👎 {t('sales.rateDown')}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
