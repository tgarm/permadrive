// Paid downloads: one section component hosting the seller side (listing
// management / pending authorisations / withdraw) and the buyer side (browse
// someone's registry / purchase / my purchases / decrypt-download), mounted by
// FilesPage. Delivery is semi-automatic: when the seller's app is online, the
// pending authorisation row unwraps K (signature channel first, passphrase
// dialog fallback), boxes it to the buyer's announced encryption pubkey, sends
// the pdgrant message over the mailbox's E2E channel and calls markDelivered.
// Digital-goods mode (buying = receiving the file, no DRM) and the escrow
// refund rules are stated in the UI. Prices show as AI3, travel as wei; state
// chips are stable identifiers with copy from the dictionary.
//
// Dual instances (R01 handling + second review F01): once
// paywallV2Address is configured it becomes the active instance — new
// listings/purchases/deliveries go through v2 (order snapshots: reprice/delist
// never affect escrowed orders; a seller namespace cannot be overwritten); v1
// is frozen read-only — while v2 is unconfigured the listing form, buy buttons
// and legacy delivery are hidden entirely (the write layer rejects too), and
// existing orders keep refund/confirm/withdraw, with legacy confirm verifying
// the current payee first. Orders render from the normalised OrderRow
// (seller/state included, never derived from the current listing).

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3, formatBytes } from '../lib/bytes'
import { getAnnouncedKey } from '../lib/mailbox'
import {
  assertLegacyPayee,
  confirmReceiptByKey,
  confirmReceiptV2,
  deliverKey,
  deliverKeyV2,
  fetchMyPurchases,
  fetchMyPurchasesV2,
  fetchPendingGrantsV2,
  getCredits,
  getCreditsV2,
  getListing,
  getListingPriceV2,
  isPdGrant,
  paywallV2Active,
  paywallV2Address,
  purchaseV2,
  refundByKey,
  refundDealV2,
  setListingPriceV2,
  unwrapDeliveredKey,
  unwrapManifestKey,
  withdrawCredits,
  withdrawCreditsV2,
  type OrderRow,
  type PdGrant,
} from '../lib/paywall'
import { fetchEntries, type RegistryEntry } from '../lib/registry'
import { getManifest, listMessages, listRegistryRecords } from '../lib/store.ts'
import { retrieveFile } from '../lib/retrieve'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { aesGcmDecrypt } from '../lib/vaultCrypto'
import { fromHex, sha256Hex } from '../lib/bytes'
import { saveBlob } from '../lib/download'
import { useI18n } from '../i18n'
import { ChainTag } from '../components/ChainTag'

const short = (a: string): string => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')

interface ViewRow {
  entry: RegistryEntry
  price: bigint | null // listing price under the active instance; null = not listed
  seller: string
}

export function PaywallSection({ getPassphrase, onNotice }: { getPassphrase: () => Promise<string | null>; onNotice?: (s: string) => void }) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()

  const v2 = paywallV2Active()
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [listings, setListings] = useState<Map<string, { price: bigint; seller: string } | null>>(new Map())
  const [pending, setPending] = useState<OrderRow[]>([])
  const [purchases, setPurchases] = useState<OrderRow[]>([])
  const [credits, setCredits] = useState<bigint | null>(null) // active instance
  const [creditsLegacy, setCreditsLegacy] = useState<bigint | null>(null) // v1 withdrawals while v2 is active
  const [priceEntry, setPriceEntry] = useState('') // selected manifestCid (listing form)
  const [priceValue, setPriceValue] = useState('')
  const [viewAddr, setViewAddr] = useState('')
  const [viewRows, setViewRows] = useState<ViewRow[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const say = useCallback((s: string) => { setNotice(s); onNotice?.(s) }, [onNotice])

  const reload = useCallback(async () => {
    if (!evm) return
    const myEntries = await fetchEntries(evm.address)
    setEntries(myEntries)
    const map = new Map<string, { price: bigint; seller: string } | null>()
    for (const e of myEntries) {
      if (v2) {
        const price = await getListingPriceV2(evm.address, e.manifestCid)
        map.set(e.manifestCid, price ? { price, seller: evm.address } : null)
      } else {
        const listing = await getListing(e.manifestCid)
        map.set(e.manifestCid, listing ? { price: listing.price, seller: listing.seller } : null)
      }
    }
    setListings(map)
    // pending authorisations come from the active instance only (v1 is frozen;
    // its legacy Escrowed orders remain deliverable through the merge below)
    // Pending authorisations come from the active instance only (F01: while v2
    // is undeployed legacy offers no delivery entry — escrowed legacy orders are
    // disposed of by the buyer via refund/confirm)
    setPending(v2 ? await fetchPendingGrantsV2(evm.address) : [])
    // my purchases: while v2 is active, merge both instances (v1 orders keep
    // refund/confirm/download)
    const legacyRows = await fetchMyPurchases(evm.address)
    setPurchases(v2 ? [...(await fetchMyPurchasesV2(evm.address)), ...legacyRows] : legacyRows)
    setCredits(v2 ? await getCreditsV2(evm.address) : await getCredits(evm.address))
    setCreditsLegacy(v2 ? await getCredits(evm.address) : null)
  }, [evm, v2])

  useEffect(() => {
    void reload().catch((e) => say(t('errors.registryTxFailed', ['read', (e as Error).message])))
  }, [reload])

  // ---- seller ----

  const listNow = async () => {
    if (!evm || !priceEntry || !priceValue) return
    if (!v2) { say(t('errors.paywallV2Required')); return } // v2 unconfigured: paid downloads are entirely unavailable
    const wei = BigInt(Math.round(Number(priceValue) * 1e18))
    if (wei <= 0n) return
    setBusy(true)
    try {
      await setListingPriceV2(evm, priceEntry, wei)
      say(t('paywall.listedOk', [priceValue]))
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
    if (!v2) { say(t('errors.paywallV2Required')); return } // v2 unconfigured (unreachable: the unlist button only renders when v2)
    setBusy(true)
    try {
      await setListingPriceV2(evm, entry.manifestCid, 0n)
      say(t('paywall.unlistedOk', [entry.name]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const deliver = async (pv: OrderRow) => {
    if (!evm || !pv.entry) return
    setBusy(true)
    try {
      say(t('paywall.delivering', [short(pv.buyer)]))
      // manifest from local storage first (the seller's own files are usually in
      // the library), otherwise recover via the registry height hint
      const rec = (await listRegistryRecords()).find((r) => r.manifestCid === pv.entry!.manifestCid)
      let manifest = rec ? await getManifest(rec.rootCid) : undefined
      const api = await connect()
      manifest ??= await recoverManifestFromHint(api, pv.entry.manifestCid, Number(pv.entry.height))
      const r =
        pv.contract === 'v2'
          ? await deliverKeyV2(evm, pv.entry.manifestCid, manifest, pv.buyer, pv.orderId!, getPassphrase)
          : await deliverKey(evm, pv.entry.manifestCid, manifest, pv.buyer, getPassphrase)
      say(t('paywall.deliveredOk', [short(pv.buyer), r.deliveredTxHash.slice(0, 14) + '…']))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (instance: 'active' | 'legacy') => {
    if (!evm) return
    setBusy(true)
    try {
      if (instance === 'legacy') await withdrawCredits(evm)
      else if (v2) await withdrawCreditsV2(evm)
      else await withdrawCredits(evm)
      say(t('paywall.withdrawnOk'))
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
      const withListings: ViewRow[] = []
      for (const entry of rows) {
        if (v2) {
          const price = await getListingPriceV2(viewAddr.trim(), entry.manifestCid)
          withListings.push({ entry, price, seller: viewAddr.trim() })
        } else {
          const listing = await getListing(entry.manifestCid)
          withListings.push({ entry, price: listing ? listing.price : null, seller: listing?.seller ?? '' })
        }
      }
      setViewRows(withListings)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const buy = async (row: ViewRow) => {
    if (!evm || !row.price || !row.seller) return
    if (!v2) { say(t('errors.paywallV2Required')); return } // v2 unconfigured: paid downloads are entirely unavailable
    setBusy(true)
    try {
      // Read-only pre-flight (zero popups): without our own announced key the
      // seller cannot deliver the file key and the order could only be
      // refunded after the delivery timeout.
      if (!(await getAnnouncedKey(evm.address))) {
        say(t('paywall.enableReceivingFirst'))
        return
      }
      const price = formatAi3(row.price)
      await purchaseV2(evm, row.entry.manifestCid, row.seller, row.price)
      say(t('paywall.purchasedOk', [row.entry.name, price]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // R05: grant messages are bound to the order — only v2 grants "addressed to
  // me, from the order's snapshot seller, matching paywall/orderId" qualify;
  // legacy orders check the sender when the seller is known. Candidates are
  // tried one by one with failures isolated, so a forged/wrong message cannot
  // shadow the correct delivery.
  const findGrant = async (pv: OrderRow): Promise<Uint8Array | null> => {
    const manifestCid = pv.entry?.manifestCid ?? null
    if (!manifestCid || !evm) return null
    const me = evm.address.toLowerCase()
    const msgs = await listMessages()
    const candidates: PdGrant[] = []
    for (const m of msgs) {
      if (!m.plain) continue
      if (m.to && m.to.toLowerCase() !== me) continue
      const g = isPdGrant(m.plain)
      if (!g || g.manifestCid !== manifestCid) continue
      if (pv.contract === 'v2' && g.v === 2) {
        if (g.orderId !== pv.orderId?.toString()) continue
        if (g.paywall?.toLowerCase() !== paywallV2Address()?.toLowerCase()) continue
        if (g.seller && pv.seller && g.seller.toLowerCase() !== pv.seller.toLowerCase()) continue
        if (pv.seller && m.from.toLowerCase() !== pv.seller.toLowerCase()) continue
      } else if (pv.seller && m.from && m.from.toLowerCase() !== pv.seller.toLowerCase()) {
        continue
      }
      candidates.push(g)
    }
    for (const g of candidates) {
      try {
        return await unwrapDeliveredKey(evm, g)
      } catch {
        // isolate a wrong candidate: try the next one
      }
    }
    return null
  }

  const downloadPurchased = async (pv: OrderRow) => {
    if (!evm || !pv.entry) return
    setBusy(true)
    try {
      let keyBytes: Uint8Array | null = await findGrant(pv)
      if (!keyBytes) {
        // pdgrant not arrived yet (self-trade skips the channel, or the seller's
        // app has not responded) — if this device already holds the file, unwrap K directly
        const rec = (await listRegistryRecords()).find((r) => r.manifestCid === pv.entry!.manifestCid)
        const localManifest = rec ? await getManifest(rec.rootCid) : undefined
        if (localManifest?.encryption) keyBytes = await unwrapManifestKey(evm, localManifest, getPassphrase)
      }
      if (!keyBytes) {
        say(t('paywall.waitingDelivery'))
        return
      }
      say(t('paywall.decryptingPurchased'))
      const api = await connect()
      const manifest = await recoverManifestFromHint(api, pv.entry.manifestCid, Number(pv.entry.height))
      const result = await retrieveFile(api, manifest)
      if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
      const plain = await aesGcmDecrypt(keyBytes, fromHex(manifest.encryption!.iv), result.bytes)
      const plainSha = await sha256Hex(plain)
      if (plainSha !== manifest.file.sha256) throw new Error(t('files.sha256Mismatch', [plainSha]))
      saveBlob(plain, manifest.file.name, manifest.file.mimeType)
      say(t('paywall.purchasedDecrypted', [manifest.file.name, plainSha.slice(0, 16)]))
      // Receipt confirmation is a separate explicit user action.
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (pv: OrderRow) => {
    if (!evm || !window.confirm(t('paywall.confirmExplain'))) return
    setBusy(true)
    try {
      if (pv.contract === 'v2') await confirmReceiptV2(evm, pv.orderId!)
      else {
        // legacy: only the key is available when entry is missing. F01 (third
        // review tightened): confirmation settles to the current listing —
        // unknown seller / removed listing refuse confirmation (the net would
        // be locked into 0x0 credits), only the refund path remains; a known
        // seller still carries TOCTOU residual risk (stated on the button)
        await assertLegacyPayee(pv.entry?.manifestCid ?? null, pv.seller)
        await confirmReceiptByKey(evm, pv.key as `0x${string}`)
      }
      say(t('paywall.confirmedOk'))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const refundRow = async (pv: OrderRow) => {
    if (!evm) return
    setBusy(true)
    try {
      if (pv.contract === 'v2') await refundDealV2(evm, pv.orderId!)
      else await refundByKey(evm, pv.key as `0x${string}`)
      say(t('paywall.refundedOk'))
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
        <h2>{t('paywall.title')}</h2>
        {creditsLegacy !== null && creditsLegacy > 0n && evm && (
          <button className="btn small" onClick={() => void withdraw('legacy')} disabled={busy} title={t('paywall.legacyTag')}>
            {t('paywall.withdrawLegacy', [formatAi3(creditsLegacy)])}
          </button>
        )}
        {credits !== null && credits > 0n && evm && (
          <button className="btn small" onClick={() => void withdraw('active')} disabled={busy}>
            {t('paywall.withdraw', [formatAi3(credits)])}
          </button>
        )}
      </div>
      <p className="privacy-note">
        <ChainTag chain="evm" /> {t('paywall.notice')}
      </p>
      {!v2 && <p className="privacy-note">{t('paywall.legacyFrozenNotice')}</p>}
      {notice && <div className="notice">{notice}</div>}
      {!evm && <div className="notice">{t('paywall.connectFirst')}</div>}

      {evm && (
        <div className="paywall-grid">
          {/* seller */}
          <div className="pw-col">
            <h3>{t('paywall.myListings')}</h3>
            {v2 ? (
              <div className="msg-compose">
                <div className="kv">
                  <span>{t('paywall.selectEntry')}</span>
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
                  <span>{t('paywall.priceLabel')}</span>
                  <input type="number" min="0" step="0.001" placeholder="0.05" value={priceValue} onChange={(e) => setPriceValue(e.target.value)} />
                </div>
                <div className="row">
                  <button className="btn small primary" disabled={busy || !priceEntry || !priceValue} onClick={() => void listNow()}>
                    {t('paywall.listBtn')}
                  </button>
                </div>
                <p className="muted small-text">{t('paywall.selectHint')}</p>
              </div>
            ) : (
              <p className="muted small-text">{t('paywall.legacyListFrozen')}</p>
            )}
            {myActiveListings.length > 0 && (
              <table className="files-table">
                <tbody>
                  {myActiveListings.map((e) => (
                    <tr key={e.manifestCid}>
                      <td>{e.name}</td>
                      <td>{formatAi3(listings.get(e.manifestCid)!.price)} AI3</td>
                      <td>
                        {v2 && (
                          <button className="btn ghost small" disabled={busy} onClick={() => void unlist(e)}>
                            {t('paywall.unlistBtn')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>{t('paywall.pendingGrants')}</h3>
            {pending.length === 0 ? (
              <p className="muted small-text">{t('paywall.pendingEmpty')}</p>
            ) : (
              <table className="files-table">
                <tbody>
                  {pending.map((pv) => (
                    <tr key={`${pv.contract}-${pv.orderId ?? pv.key}-${pv.buyer}`}>
                      <td>
                        <div>{pv.entry?.name ?? pv.key.slice(0, 14) + '…'}</div>
                        <div className="mono small-text muted">{short(pv.buyer)}</div>
                      </td>
                      <td>{formatAi3(pv.price)} AI3</td>
                      <td>
                        <button className="btn small primary" disabled={busy} onClick={() => void deliver(pv)}>
                          {t('paywall.deliver')}
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
            <h3>{t('paywall.viewDirectory')}</h3>
            <div className="kv">
              <span>{t('paywall.addressLabel')}</span>
              <input className="mono" placeholder="0x…" value={viewAddr} onChange={(e) => setViewAddr(e.target.value)} />
            </div>
            <div className="row">
              <button className="btn small" disabled={busy || !viewAddr.trim()} onClick={() => void viewDirectory()}>
                {t('paywall.view')}
              </button>
            </div>
            {viewRows && (
              viewRows.length === 0 ? (
                <p className="muted small-text">{t('paywall.viewEmpty')}</p>
              ) : (
                <table className="files-table">
                  <tbody>
                    {viewRows.map((row) => (
                      <tr key={row.entry.manifestCid}>
                        <td>
                          <div>{row.entry.name}</div>
                          <div className="muted small-text">{formatBytes(Number(row.entry.size))}</div>
                        </td>
                        <td>
                          {row.price ? (
                            v2 ? (
                              <button className="btn small primary" disabled={busy} onClick={() => void buy(row)}>
                                {t('paywall.buy')} · {formatAi3(row.price)} AI3
                              </button>
                            ) : (
                              <span className="muted small-text">{t('paywall.legacyFrozenShort')}</span>
                            )
                          ) : (
                            <span className="muted small-text">{t('paywall.notListed')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            <h3>{t('paywall.myPurchases')}</h3>
            {purchases.length === 0 ? (
              <p className="muted small-text">{t('paywall.purchasesEmpty')}</p>
            ) : (
              <table className="files-table">
                <tbody>
                  {purchases.map((pv) => (
                    <tr key={`${pv.contract}-${pv.orderId ?? pv.key}-${pv.buyer}`}>
                      <td>
                        <div>
                          {pv.entry?.name ?? pv.key.slice(0, 14) + '…'}
                          {v2 && pv.contract === 'legacy' && <span className="muted small-text"> · {t('paywall.legacyTag')}</span>}
                        </div>
                        <div className="muted small-text">
                          {t(`paywall.state.${['none', 'escrowed', 'delivered', 'released', 'refunded'][pv.state]}`)} · {formatAi3(pv.price)} AI3 · {short(pv.seller)}
                        </div>
                      </td>
                      <td>
                        {(pv.state === 1 || pv.state === 2) && (
                          <>
                            {pv.entry && (
                              <button className="btn small" disabled={busy} onClick={() => void downloadPurchased(pv)}>
                                {t('paywall.downloadPurchased')}
                              </button>
                            )}{' '}
                            <button
                              className="btn ghost small"
                              disabled={busy}
                              onClick={() => void confirm(pv)}
                              title={pv.contract === 'legacy' ? t('paywall.legacyConfirmRisk') : undefined}
                            >
                              {t('paywall.confirmReceipt')}
                            </button>{' '}
                            <button className="btn ghost small" disabled={busy} onClick={() => void refundRow(pv)}>
                              {t('paywall.refundBtn')}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
