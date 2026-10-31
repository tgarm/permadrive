// Direct-sales section (phase-one UI): seller (list / reprice = new revision /
// deliver pending orders) + buyer (browse a directory / pay directly /
// decrypt-download / rate up or down). Payment splits instantly, no platform
// refunds, no escrow, no withdrawal — mounted on FilesPage alongside
// PaywallSection (escrow existing-order disposition), rendered only once
// config.salesAddress is configured. Delivery is semi-automatic: with the
// seller's app online they click Deliver on a pending order — unwrap K →
// pdgrant v3 private message (over the Mailbox E2E channel) → markKeySent
// (optional registration; never blocks the buyer's download). Ratings need no
// delivery precondition (an undelivered buyer may rate negatively); a vote
// change subtracts before it adds; on-chain rating costs gas, explained in a
// confirm dialog up front.
//
// Wallet-dialog transparency (same policy as the first wallet-dialog batch):
// the purchase confirm states "no platform refunds + the seller must be online
// + gas"; a read-only, zero-popup recipient-key precheck (getAnnouncedKey)
// guides enabling message receiving first — otherwise the seller cannot encrypt
// the delivery. Prices display in AI3 and go on-chain in wei.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3, formatBytes } from '../lib/bytes'
import { getAnnouncedKey } from '../lib/mailbox'
import { unwrapManifestKey } from '../lib/paywall'
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

export function SalesSection({ getPassphrase, onNotice }: { getPassphrase: () => Promise<string | null>; onNotice?: (s: string) => void }) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()

  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [listings, setListings] = useState<Map<string, { price: bigint; revision: bigint } | null>>(new Map())
  const [ratings, setRatings] = useState<Map<string, { up: bigint; down: bigint; buyers: bigint }>>(new Map())
  const [pending, setPending] = useState<SalesOrderRow[]>([])
  const [orders, setOrders] = useState<SalesOrderRow[]>([])
  const [votes, setVotes] = useState<Map<string, number>>(new Map()) // lid → current vote
  const [priceEntry, setPriceEntry] = useState('')
  const [priceValue, setPriceValue] = useState('')
  const [viewAddr, setViewAddr] = useState('')
  const [viewRows, setViewRows] = useState<{ entry: RegistryEntry; listing: Awaited<ReturnType<typeof getListingSales>> }[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const say = useCallback((s: string) => { setNotice(s); onNotice?.(s) }, [onNotice])

  const reload = useCallback(async () => {
    if (!evm || !salesActive()) return
    const myEntries = await fetchEntries(evm.address)
    setEntries(myEntries)
    const lmap = new Map<string, { price: bigint; revision: bigint } | null>()
    const rmap = new Map<string, { up: bigint; down: bigint; buyers: bigint }>()
    const vmap = new Map<string, number>()
    for (const e of myEntries) {
      const l = await getListingSales(evm.address, e.manifestCid)
      lmap.set(e.manifestCid, l ? { price: l.price, revision: l.revision } : null)
      rmap.set(e.manifestCid, await getRatingSales(evm.address, e.manifestCid))
    }
    setListings(lmap)
    setRatings(rmap)
    // pending deliveries (Paid) and my purchases (all)
    setPending(await fetchSellerOrdersSales(evm.address))
    const rows = await fetchMyOrdersSales(evm.address)
    setOrders(rows)
    for (const row of rows) {
      if (!row.entry) continue
      const lid = row.entry.manifestCid
      if (!vmap.has(lid)) vmap.set(lid, await getVoteSales(row.seller, lid, evm.address))
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
      const rows = await fetchEntries(viewAddr.trim())
      const out: { entry: RegistryEntry; listing: Awaited<ReturnType<typeof getListingSales>> }[] = []
      for (const entry of rows) {
        out.push({ entry, listing: await getListingSales(viewAddr.trim(), entry.manifestCid) })
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
      // recipient-key precheck (read-only, zero popups): without it the seller cannot encrypt the delivery
      if (!(await getAnnouncedKey(evm.address))) {
        say(t('paywall.enableReceivingFirst'))
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
      await purchaseSalesWithQuote(evm, quote)
      say(t('sales.purchasedOk', [entry.name, formatAi3(quote.price)]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // pdgrant v3 strict match: addressed to self, from the order's seller (or snapshot
  // provider), sales/orderId/manifestCid all matching; wrong candidates are isolated
  // and tried one by one
  const findGrant = async (row: SalesOrderRow): Promise<Uint8Array | null> => {
    if (!evm || !row.entry) return null
    const me = evm.address.toLowerCase()
    const msgs = await listMessages()
    const candidates = []
    for (const m of msgs) {
      if (!m.plain) continue
      if (m.to && m.to.toLowerCase() !== me) continue
      if (m.from.toLowerCase() !== row.seller && (!row.provider || m.from.toLowerCase() !== row.provider)) continue
      const g = isPdGrantV3(m.plain)
      if (!g || g.manifestCid !== row.entry.manifestCid) continue
      if (g.orderId !== row.orderId.toString() || g.buyer?.toLowerCase() !== me || g.seller?.toLowerCase() !== row.seller) continue
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

  const downloadPurchased = async (row: SalesOrderRow) => {
    if (!evm || !row.entry) return
    setBusy(true)
    try {
      const keyBytes = await findGrant(row)
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
    if (!manifest.encryption) throw new Error(t('errors.paywallNotEncrypted'))
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
  // negatively); gas stated up front; clicking the same vote again is a no-op
  const vote = async (row: SalesOrderRow, positive: boolean) => {
    if (!evm || !row.entry) return
    const lid = row.entry.manifestCid
    const current = votes.get(lid) ?? 0
    if ((positive && current === 1) || (!positive && current === -1)) return // same vote no-op (contract-idempotent)
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

  const myActiveListings = entries.filter((e) => (listings.get(e.manifestCid)?.price ?? 0n) > 0n)

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('sales.title')}</h2>
      </div>
      <p className="privacy-note">{t('sales.notice')}</p>
      {notice && <div className="notice">{notice}</div>}
      {!evm && <div className="notice">{t('sales.connectFirst')}</div>}

      {evm && (
        <div className="paywall-grid">
          {/* seller */}
          <div className="pw-col">
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
                    const r = ratings.get(e.manifestCid)
                    return (
                      <tr key={e.manifestCid}>
                        <td>
                          <div>{e.name}</div>
                          <div className="muted small-text">
                            {r && (r.up > 0n || r.down > 0n)
                              ? t('sales.ratingLine', [r.up.toString(), r.down.toString(), r.buyers.toString()])
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
          <div className="pw-col">
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
                    {viewRows.map(({ entry, listing }) => {
                      const r = ratings.get(entry.manifestCid)
                      return (
                        <tr key={entry.manifestCid}>
                          <td>
                            <div>{entry.name}</div>
                            <div className="muted small-text">
                              {formatBytes(Number(entry.size))}
                              {listing && (r!.up > 0n || r!.down > 0n) ? ' · ' + t('sales.ratingLine', [r!.up.toString(), r!.down.toString(), r!.buyers.toString()]) : ''}
                              {listing && r && r.up === 0n && r.down === 0n ? ' · ' + t('sales.noRatings') : ''}
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

            <h3>{t('sales.myOrders')}</h3>
            {orders.length === 0 ? (
              <p className="muted small-text">{t('sales.ordersEmpty')}</p>
            ) : (
              <table className="files-table">
                <tbody>
                  {orders.map((row) => {
                    const myVote = row.entry ? votes.get(row.entry.manifestCid) ?? 0 : 0
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
