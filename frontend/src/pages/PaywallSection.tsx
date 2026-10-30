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

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3, formatBytes } from '../lib/bytes'
import {
  confirmReceipt,
  deliverKey,
  fetchMyPurchases,
  fetchPendingGrants,
  getCredits,
  getListing,
  isPdGrant,
  purchase,
  setListingPrice,
  unwrapDeliveredKey,
  unwrapManifestKey,
  withdrawCredits,
  type Listing,
  type PurchaseView,
} from '../lib/paywall'
import { fetchEntries, type RegistryEntry } from '../lib/registry'
import { getManifest, listMessages, listRegistryRecords } from '../lib/store'
import { retrieveFile } from '../lib/retrieve'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { aesGcmDecrypt } from '../lib/vaultCrypto'
import { fromHex, sha256Hex } from '../lib/bytes'
import { saveBlob } from '../lib/download'
import { useI18n } from '../i18n'

const short = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`

interface ViewRow {
  entry: RegistryEntry
  listing: Listing | null
}

export function PaywallSection({ getPassphrase, onNotice }: { getPassphrase: () => Promise<string | null>; onNotice?: (s: string) => void }) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()

  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [listings, setListings] = useState<Map<string, Listing | null>>(new Map())
  const [pending, setPending] = useState<PurchaseView[]>([])
  const [purchases, setPurchases] = useState<PurchaseView[]>([])
  const [credits, setCredits] = useState<bigint | null>(null)
  const [priceEntry, setPriceEntry] = useState('') // the selected manifestCid (listing form)
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
    const map = new Map<string, Listing | null>()
    for (const e of myEntries) map.set(e.manifestCid, await getListing(e.manifestCid))
    setListings(map)
    setPending(await fetchPendingGrants(evm.address))
    setPurchases(await fetchMyPurchases(evm.address))
    setCredits(await getCredits(evm.address))
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
      await setListingPrice(evm, priceEntry, wei)
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
    setBusy(true)
    try {
      await setListingPrice(evm, entry.manifestCid, 0n)
      say(t('paywall.unlistedOk', [entry.name]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const deliver = async (pv: PurchaseView) => {
    if (!evm || !pv.entry) return
    setBusy(true)
    try {
      say(t('paywall.delivering', [short(pv.log.buyer)]))
      // prefer the local manifest (sellers usually keep their own file), otherwise restore it via the registry height
      const rec = (await listRegistryRecords()).find((r) => r.manifestCid === pv.entry!.manifestCid)
      let manifest = rec ? await getManifest(rec.rootCid) : undefined
      const api = await connect()
      manifest ??= await recoverManifestFromHint(api, pv.entry.manifestCid, Number(pv.entry.height))
      const r = await deliverKey(evm, pv.entry.manifestCid, manifest, pv.log.buyer, getPassphrase)
      say(t('paywall.deliveredOk', [short(pv.log.buyer), r.deliveredTxHash.slice(0, 14) + '…']))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const doWithdraw = async () => {
    if (!evm) return
    setBusy(true)
    try {
      await withdrawCredits(evm)
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
      for (const entry of rows) withListings.push({ entry, listing: await getListing(entry.manifestCid) })
      setViewRows(withListings)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const buy = async (row: ViewRow) => {
    if (!evm || !row.listing || row.listing.price === 0n) return
    setBusy(true)
    try {
      const price = formatAi3(row.listing.price)
      await purchase(evm, row.entry.manifestCid, row.listing.price)
      say(t('paywall.purchasedOk', [row.entry.name, price]))
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const findGrant = async (manifestCid: string | null) => {
    if (!manifestCid) return null
    const msgs = await listMessages()
    for (const m of msgs) {
      if (!m.plain) continue
      const grant = isPdGrant(m.plain)
      if (grant && grant.manifestCid === manifestCid) return grant
    }
    return null
  }

  const downloadPurchased = async (pv: PurchaseView) => {
    if (!evm || !pv.entry) return
    setBusy(true)
    try {
      const grant = await findGrant(pv.entry.manifestCid)
      let keyBytes: Uint8Array | null = null
      if (grant) keyBytes = await unwrapDeliveredKey(evm, grant)
      if (!keyBytes) {
        // no pdgrant yet (self-trade never uses the channel, or the seller hasn't responded) — unwrap K from the local manifest if present
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
      // a successful decryption confirms receipt (pays the seller out); failures can refund within the grace period
      await confirmReceipt(evm, pv.entry.manifestCid)
      await reload()
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (pv: PurchaseView) => {
    if (!evm || !pv.entry) return
    setBusy(true)
    try {
      await confirmReceipt(evm, pv.entry.manifestCid)
      say(t('paywall.confirmedOk'))
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
        {credits !== null && credits > 0n && evm && (
          <button className="btn small" onClick={() => void doWithdraw()} disabled={busy}>
            {t('paywall.withdraw', [formatAi3(credits)])}
          </button>
        )}
      </div>
      <p className="privacy-note">{t('paywall.notice')}</p>
      {notice && <div className="notice">{notice}</div>}
      {!evm && <div className="notice">{t('paywall.connectFirst')}</div>}

      {evm && (
        <div className="paywall-grid">
          {/* seller */}
          <div className="pw-col">
            <h3>{t('paywall.myListings')}</h3>
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
            {myActiveListings.length > 0 && (
              <table className="files-table">
                <tbody>
                  {myActiveListings.map((e) => (
                    <tr key={e.manifestCid}>
                      <td>{e.name}</td>
                      <td>{formatAi3(listings.get(e.manifestCid)!.price)} AI3</td>
                      <td>
                        <button className="btn ghost small" disabled={busy} onClick={() => void unlist(e)}>
                          {t('paywall.unlistBtn')}
                        </button>
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
                    <tr key={pv.log.txHash}>
                      <td>
                        <div>{pv.entry?.name ?? pv.log.key.slice(0, 14) + '…'}</div>
                        <div className="mono small-text muted">{short(pv.log.buyer)}</div>
                      </td>
                      <td>{formatAi3(pv.log.price)} AI3</td>
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
                          {row.listing && row.listing.price > 0n ? (
                            <button className="btn small primary" disabled={busy} onClick={() => void buy(row)}>
                              {t('paywall.buy')} · {formatAi3(row.listing.price)} AI3
                            </button>
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
                    <tr key={pv.log.txHash}>
                      <td>
                        <div>{pv.entry?.name ?? pv.log.key.slice(0, 14) + '…'}</div>
                        <div className="muted small-text">
                          {t(`paywall.state.${['none', 'escrowed', 'delivered', 'released', 'refunded'][pv.deal.state]}`)} · {formatAi3(pv.log.price)} AI3 · {short(pv.seller)}
                        </div>
                      </td>
                      <td>
                        {(pv.deal.state === 1 || pv.deal.state === 2) && (
                          <>
                            <button className="btn small" disabled={busy} onClick={() => void downloadPurchased(pv)}>
                              {t('paywall.downloadPurchased')}
                            </button>{' '}
                            <button className="btn ghost small" disabled={busy} onClick={() => void confirm(pv)}>
                              {t('paywall.confirmReceipt')}
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
