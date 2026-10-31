// Share center — phase 1 with two sections:
//  1. Deep-link landing: parses `#/s?m&h&o[&k]` (parameters are never trusted;
//     shareLink.ts validates) -> recovers the manifest (owner Registry entry
//     first, height hint fallback, then the Published-event hint; no full-chain
//     scan) -> branches by file state: plaintext (retrieve, verify, download) /
//     public (key from the link or the Published event — zero wallets needed;
//     the event digest/size comparison after decrypt is mandatory) / for-sale
//     (show the quote -> buy -> the delivery lands in My Purchases).
//  2. My Purchases (simple phase-1 view, migrated from the dissolved
//     SalesSection buyer column): order list / inbox sync / pdgrant v3
//     decrypt-and-download / ratings. The "my shares" aggregate view is
//     phase 2.
//
// Deep-link integrity: the hash is kept, never cleared (the landing view is
// read-only and idempotent; transactions only fire on explicit clicks); a
// key-carrying link alone never claims "public on-chain" (it shows
// "key-carrying link"); GCM authentication is not the same as the content
// matching the public claim — the post-decrypt comparison against the event
// digest/size is mandatory.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3, formatBytes, fromHex, sha256Hex } from '../lib/bytes'
import { ChainTag } from '../components/ChainTag'
import {
  fetchPublishedByKey,
  publicPublisherActive,
  type PublishedEvent,
} from '../lib/publicPublisher'
import { decryptMessage, encryptionPublicKeyFor, getAnnouncedKey, mailboxAddress, syncMessages } from '../lib/mailbox'
import {
  fetchMyOrdersSales,
  getVoteSales,
  isPdGrantV3,
  purchaseQuote,
  purchaseSalesWithQuote,
  rateSales,
  salesActive,
  salesAddress,
  unwrapDeliveredKeySales,
  type PdGrantV3,
  type SalesOrderRow,
} from '../lib/sales'
import { fetchEntries, type RegistryEntry } from '../lib/registry'
import { getManifest, listMessages, listRegistryRecords } from '../lib/store'
import { retrieveFile } from '../lib/retrieve'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { aesGcmDecrypt } from '../lib/vaultCrypto'
import { unwrapManifestKey } from '../lib/keyUnwrap'
import { autoEvmChain } from '../lib/evm'
import { saveBlob } from '../lib/download'
import type { ApiPromise } from '@polkadot/api'
import type { Manifest } from '../lib/manifest'
import type { ShareLinkParams } from '../lib/shareLink'
import type { EvmSigner } from '../lib/wallet/types'
import { useI18n } from '../i18n'
import { t } from '../i18n/core.ts'

const short = (a: string): string => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// Rating/vote cache keys must include the seller (the same CID from two sellers must never mix ratings)
const ratingKey = (seller: string, cid: string) => `${seller.toLowerCase()}:${cid}`

type LandingPhase =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'ready'; manifest: Manifest; entry: RegistryEntry | null; event: PublishedEvent | null; keySource: 'link' | 'event' | null }
  | { kind: 'failed'; message: string }

/** Decrypt + integrity gate (mismatches block saving; exporting unverified
 *  bytes needs an explicit confirm). When an event exists, comparing the
 *  plaintext digest/size is mandatory — GCM authentication does not mean the
 *  content matches the public claim. */
async function decryptAndSave(
  api: ApiPromise,
  manifest: Manifest,
  keyBytes: Uint8Array,
  say: (s: string) => void,
  event: PublishedEvent | null,
): Promise<void> {
  if (!manifest.encryption) throw new Error(t('errors.manifestNotEncrypted'))
  const result = await retrieveFile(api, manifest)
  if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
  say(t('share.decryptingPublic'))
  const plain = await aesGcmDecrypt(keyBytes, fromHex(manifest.encryption.iv), result.bytes)
  const plainSha = await sha256Hex(plain)
  if (plainSha !== manifest.file.sha256 || plain.length !== manifest.file.size) {
    if (window.confirm(t('share.integrityBlockExport', [plainSha.slice(0, 16)]))) saveBlob(plain, manifest.file.name, manifest.file.mimeType)
    return
  }
  if (event) {
    const evSha = event.plainSha256.replace(/^0x/, '').toLowerCase()
    if (evSha !== plainSha || Number(event.plainSize) !== plain.length) {
      if (!window.confirm(t('share.eventMismatchExport'))) return
    }
  }
  saveBlob(plain, manifest.file.name, manifest.file.mimeType)
  say(t('share.decryptedOk', [manifest.file.name, plainSha.slice(0, 16)]))
}

/** Strict pdgrant v3 matching: message chain/contract domain plus the grant's
 *  chainId/sales/orderId/buyer/seller/provider all checked against the order
 *  snapshot; bad candidates are isolated and tried one by one */
async function findGrant(evm: EvmSigner, row: SalesOrderRow): Promise<Uint8Array | null> {
  const me = evm.address.toLowerCase()
  const sales = salesAddress()?.toLowerCase()
  if (!sales || !row.entry) return null
  const mailbox = mailboxAddress().toLowerCase()
  const expectedProvider = row.provider && row.provider !== ZERO_ADDR ? row.provider.toLowerCase() : null
  const msgs = await listMessages()
  const candidates: PdGrantV3[] = []
  for (const m of msgs) {
    if (!m.plain) continue
    if (m.to && m.to.toLowerCase() !== me) continue
    if (m.chainId != null && m.chainId !== autoEvmChain.id) continue
    if (!m.id.toLowerCase().startsWith(`${mailbox}:`)) continue
    if (m.from.toLowerCase() !== row.seller && (!expectedProvider || m.from.toLowerCase() !== expectedProvider)) continue
    const g = isPdGrantV3(m.plain)
    if (!g || g.manifestCid !== row.entry.manifestCid) continue
    if (g.chainId !== autoEvmChain.id) continue
    if (g.sales.toLowerCase() !== sales) continue
    if (g.orderId !== row.orderId.toString() || g.buyer?.toLowerCase() !== me || g.seller?.toLowerCase() !== row.seller) continue
    if (expectedProvider ? g.provider?.toLowerCase() !== expectedProvider : !!g.provider && g.provider.toLowerCase() !== ZERO_ADDR) continue
    candidates.push(g)
  }
  for (const g of candidates) {
    try {
      return await unwrapDeliveredKeySales(evm, g)
    } catch {
      /* bad candidate isolated: try the next (box unsealing has its own auth tag) */
    }
  }
  return null
}

// ---- Deep-link landing ----

function ShareLanding({ params }: { params: ShareLinkParams }) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()
  const [phase, setPhase] = useState<LandingPhase>({ kind: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [quote, setQuote] = useState<{ price: bigint; revision: bigint; listingId: `0x${string}` } | null>(null)
  const [notListed, setNotListed] = useState(false)

  const say = setNotice

  const resolve = useCallback(async () => {
    setPhase({ kind: 'resolving' })
    try {
      const api = await connect()
      let entry: RegistryEntry | null = null
      let manifest: Manifest | null = null
      // (1) a valid owner -> Registry is authoritative (name/size + height)
      if (params.owner) {
        try {
          const entries = await fetchEntries(params.owner)
          entry = entries.find((e) => e.manifestCid === params.manifestCid) ?? null
        } catch {
          /* Registry read failed — fall back to the height hint */
        }
      }
      if (entry) {
        manifest = await recoverManifestFromHint(api, params.manifestCid, Number(entry.height))
      } else if (params.height != null) {
        // (2) the h height hint (includes the +3 reorg tolerance)
        manifest = await recoverManifestFromHint(api, params.manifestCid, params.height)
      } else if (publicPublisherActive()) {
        // (3) the Published event's manifestHeightHint (third locating path for public files)
        const ev = await fetchPublishedByKey(params.manifestCid)
        if (ev && ev.manifestHeightHint > 0n) manifest = await recoverManifestFromHint(api, params.manifestCid, Number(ev.manifestHeightHint))
      }
      if (!manifest) {
        setPhase({ kind: 'failed', message: t('share.landingUnresolved') })
        return
      }
      const event = publicPublisherActive() ? await fetchPublishedByKey(params.manifestCid) : null
      const keySource = params.key ? 'link' : event ? 'event' : null
      setPhase({ kind: 'ready', manifest, entry, event, keySource })
      // For-sale quote (show the buy entry when an owner exists and no event)
      if (params.owner && !event && manifest.encryption) {
        try {
          const q = await purchaseQuote(params.owner, params.manifestCid)
          setQuote(q)
          setNotListed(!q)
        } catch {
          setNotListed(true)
        }
      }
    } catch (e) {
      setPhase({ kind: 'failed', message: (e as Error).message })
    }
  }, [params, connect, t])

  useEffect(() => {
    void resolve()
  }, [resolve])

  // Plaintext download (sha256 + length integrity gate)
  const downloadPlain = async () => {
    if (phase.kind !== 'ready') return
    setBusy(true)
    try {
      const api = await connect()
      const result = await retrieveFile(api, phase.manifest)
      if (!(result.sha256Match && result.bytes.length === phase.manifest.file.size)) {
        if (!window.confirm(t('share.integrityBlockExport', [result.sha256.slice(0, 16)]))) return
      }
      saveBlob(result.bytes, phase.manifest.file.name, phase.manifest.file.mimeType)
      say(t('share.plainSaved', [result.sha256.slice(0, 16)]))
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // Public decrypt-and-download (K from the link k or the Published event key — zero wallets)
  const downloadPublic = async () => {
    if (phase.kind !== 'ready') return
    setBusy(true)
    try {
      const keyHex0 = params.key ?? phase.event?.key ?? null
      if (!keyHex0) throw new Error(t('share.noKeyAvailable'))
      const api = await connect()
      await decryptAndSave(api, phase.manifest, fromHex(keyHex0), say, phase.event)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // For-sale purchase (confirm: no refunds + seller must be online + gas;
  // receiving prechecks per the wallet-transparency rules)
  const buy = async () => {
    if (!evm || !params.owner) return
    setBusy(true)
    try {
      const announced = await getAnnouncedKey(evm.address)
      if (!announced) {
        say(t('sales.enableReceivingFirst'))
        return
      }
      const fresh = await purchaseQuote(params.owner, params.manifestCid)
      if (!fresh) {
        say(t('sales.notListed'))
        return
      }
      if (!window.confirm(t('sales.buyConfirm', [formatAi3(fresh.price)]))) return
      const currentKey = await encryptionPublicKeyFor(evm)
      if (currentKey !== announced) {
        say(t('sales.receiveKeyMismatch'))
        return
      }
      await purchaseSalesWithQuote(evm, fresh)
      say(t('sales.purchasedOk', [phase.kind === 'ready' ? phase.manifest.file.name : '', formatAi3(fresh.price)]))
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (phase.kind === 'resolving') return <p className="muted">{t('share.landingResolving')}</p>
  if (phase.kind === 'failed')
    return (
      <div>
        <div className="error-text">{phase.message}</div>
      </div>
    )
  if (phase.kind !== 'ready') return null

  const { manifest, entry, event, keySource } = phase
  // Status label (a key in the link alone never claims "public on-chain" ->
  // show "key-carrying link")
  const statusLabel = (() => {
    if (!manifest.encryption) return t('share.landingPlainBadge')
    if (event) {
      const evSha = event.plainSha256.replace(/^0x/, '').toLowerCase()
      const evOk = evSha === manifest.file.sha256.toLowerCase() && Number(event.plainSize) === manifest.file.size
      return evOk ? t('share.landingPublicVerified') : t('share.landingEventMismatch')
    }
    if (keySource === 'link') return t('share.landingKeyOnly')
    return t('share.landingUnshared')
  })()

  return (
    <div className="share-landing">
      <div className="kv">
        <span>{t('share.landingFile')}</span>
        <span>
          {manifest.encryption ? '🔒 ' : '🌐 '}
          {manifest.file.name}
        </span>
      </div>
      <div className="kv">
        <span>{t('common.size')}</span>
        <span>{formatBytes(manifest.file.size)}</span>
      </div>
      <div className="kv">
        <span>{t('share.landingStatus')}</span>
        <span>{statusLabel}</span>
      </div>
      {entry && params.owner && (
        <div className="kv">
          <span>{t('share.landingOwner')}</span>
          <span className="mono small-text">{short(params.owner)}</span>
        </div>
      )}
      <div className="row">
        {!manifest.encryption && (
          <button className="btn primary" disabled={busy} onClick={() => void downloadPlain()}>
            {t('common.download')}
          </button>
        )}
        {manifest.encryption && keySource && (
          <button className="btn primary" disabled={busy} onClick={() => void downloadPublic()}>
            {t('share.downloadDecrypted')}
          </button>
        )}
        {manifest.encryption && !keySource && quote && (
          <button className="btn primary" disabled={busy || !evm} onClick={() => void buy()}>
            {t('sales.buy')} · {formatAi3(quote.price)} AI3
          </button>
        )}
      </div>
      {manifest.encryption && !keySource && !quote && notListed && <p className="muted small-text">{t('sales.notListed')}</p>}
      {manifest.encryption && !keySource && !quote && !notListed && <p className="muted small-text">{t('share.noKeyAvailable')}</p>}
      {manifest.encryption && keySource === 'event' && <p className="muted small-text">{t('share.keyFromEventNote')}</p>}
      {manifest.encryption && keySource && !evm && <p className="muted small-text">{t('share.zeroWalletNote')}</p>}
      {event && <p className="muted small-text">{t('share.eventLine', [event.txHash.slice(0, 18) + '…'])}</p>}
      {notice && <div className="notice">{notice}</div>}
      <p className="muted small-text">{t('share.landingFooter')}</p>
    </div>
  )
}

// ---- My Purchases (simple phase-1 view, migrated from the SalesSection
// buyer column) ----
// Passphrase fallback: when the file already exists locally and the signature
// channel cannot unwrap (a passphrase-channel self-purchase), direct the user
// to the Files page — the Share tab does not reuse FilesPage's passphrase
// prompt (cross-page state; polished in phase 2).

function MyPurchases() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { evm } = useSigner()
  const [orders, setOrders] = useState<SalesOrderRow[]>([])
  const [votes, setVotes] = useState<Map<string, number>>(new Map())
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const say = setNotice

  const reload = useCallback(async () => {
    if (!evm || !salesActive()) return
    const rows = await fetchMyOrdersSales(evm.address)
    setOrders(rows)
    const vmap = new Map<string, number>()
    for (const row of rows) {
      if (!row.entry) continue
      const k = ratingKey(row.seller, row.entry.manifestCid)
      if (!vmap.has(k)) vmap.set(k, await getVoteSales(row.seller, row.entry.manifestCid, evm.address))
    }
    setVotes(vmap)
  }, [evm])

  useEffect(() => {
    void reload().catch((e) => say(`✗ ${(e as Error).message}`))
  }, [reload])

  /** Inbox sync + targeted decryption (only messages from the current
   *  orders' counterparts are decrypted; the fewest prompts) */
  const syncAndDecryptFor = async (rows: SalesOrderRow[]) => {
    if (!evm) return
    const me = evm.address.toLowerCase()
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
        await decryptMessage(evm, m) // per-item failure isolation
      } catch {
        /* undecryptable (e.g. old ciphertext from another chain) stays as-is */
      }
    }
  }

  const downloadPurchased = async (row: SalesOrderRow) => {
    if (!evm || !row.entry) return
    setBusy(true)
    try {
      let keyBytes = await findGrant(evm, row)
      if (!keyBytes) {
        // No decrypted pdgrant locally: sync + targeted decrypt, then retry (user-clicked)
        try {
          say(t('sales.syncingInbox'))
          await syncAndDecryptFor([row])
          keyBytes = await findGrant(evm, row)
        } catch {
          /* sync failure counts as not-yet-delivered */
        }
      }
      if (!keyBytes) {
        // pdgrant not arrived (self-purchase skips the channel, or the seller
        // is offline) — if the file exists locally, unwrap K directly
        const rec = (await listRegistryRecords()).find((r) => r.manifestCid === row.entry!.manifestCid)
        const localManifest = rec ? await getManifest(rec.rootCid) : undefined
        if (localManifest?.encryption) {
          const k = await unwrapManifestKey(evm, localManifest, () => Promise.resolve(null))
          await decryptAndSave(await connect(), localManifest, k, say, null)
          return
        }
        say(t('sales.waitingDelivery'))
        return
      }
      const api = await connect()
      const manifest = await recoverManifestFromHint(api, row.entry.manifestCid, Number(row.entry.height))
      await decryptAndSave(api, manifest, keyBytes, say, null)
    } catch (e) {
      say(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // Rating: no delivery precondition; same-vote re-clicks say so explicitly
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

  if (!salesActive()) return null

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('sales.myOrders')}</h2>
        {orders.length > 0 && (
          <button className="btn ghost small" disabled={busy} title={t('sales.syncInboxHint')} onClick={() => void syncInbox()}>
            {t('sales.syncInbox')}
          </button>
        )}
      </div>
      <p className="privacy-note">
        <ChainTag chain="evm" /> {t('share.purchasesNotice')}
      </p>
      {notice && <div className="notice">{notice}</div>}
      {!evm && <div className="notice">{t('share.needEvm')}</div>}
      {evm && orders.length === 0 && <p className="muted small-text">{t('sales.ordersEmpty')}</p>}
      {evm && orders.length > 0 && (
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
                      <>
                        <button className="btn small" disabled={busy} onClick={() => void downloadPurchased(row)}>
                          {t('sales.downloadPurchased')}
                        </button>{' '}
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
    </section>
  )
}

export function SharePage({ deepLink }: { deepLink: ShareLinkParams | null }) {
  const { t } = useI18n()
  return (
    <div className="page">
      {deepLink && (
        <section className="card">
          <div className="card-head">
            <h2>{t('share.landingTitle')}</h2>
          </div>
          <ShareLanding params={deepLink} />
        </section>
      )}
      <MyPurchases />
    </div>
  )
}
