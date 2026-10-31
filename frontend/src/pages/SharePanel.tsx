// Per-file share panel (three-state model): on-chain state derivation
// (unshared / for-sale / public) and the transitions — list for sale
// (createRevision), delist (buyers keep their K), make public (1 wei dust
// price + Published event; broadcast counts as disclosure). History hints
// (everSold/everDisclosed) are local-only enhancements, never on-chain
// omniscience. Disclosure state machine: disclosureAttempted is persisted
// before the signature reaches the wallet; after broadcast, any failure
// (revert/lost/replaced) shows "public (unconfirmed)" and never falls back to
// unshared; only a rejected signature (nothing broadcast) clears the marker
// and keeps the prior state. "Copy public link" is itself a disclosure.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatAi3 } from '../lib/bytes'
import { ChainTag } from '../components/ChainTag'
import {
  createRevisionSales,
  delistSales,
  deliverKeySales,
  fetchSellerOrdersSales,
  getListingSales,
  getRatingSales,
  type ListingView,
  type SalesOrderRow,
} from '../lib/sales'
import {
  fetchPublishedByKey,
  hasDisclosureAttempted,
  hasEverDisclosed,
  hasEverSold,
  keyHex,
  markDisclosureAttempted,
  markEverDisclosed,
  markEverSold,
  publicPublisherActive,
  publishPublic,
  unmarkDisclosureAttempted,
} from '../lib/publicPublisher'
import { buildShareLink } from '../lib/shareLink'
import { unwrapManifestKey } from '../lib/keyUnwrap'
import {
  getManifestPublishMeta,
  publishManifestToChain,
  putManifestPublishMeta,
  type ManifestPublicationMeta,
} from '../lib/manifestPublish'
import type { Manifest } from '../lib/manifest'
import type { RegistryRecord } from '../lib/store'
import { useI18n } from '../i18n'

const USER_REJECTED = /4001|UserRejected|user rejected|rejected the request|denied/i

const isUserRejected = (e: unknown): boolean => {
  const err = e as { code?: number | string; message?: string; shortMessage?: string }
  return String(err?.code ?? '') === '4001' || USER_REJECTED.test(`${err?.shortMessage ?? ''} ${err?.message ?? ''}`)
}

export interface SharePanelProps {
  manifest: Manifest
  registryRecord: RegistryRecord | null
  getPassphrase: () => Promise<string | null>
  onNotice: (s: string) => void
  onChanged: () => void
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'plain' }
  | { kind: 'unshared'; manifestCid: string | null; height: number | null }
  | { kind: 'paid'; manifestCid: string; height: number | null; listing: ListingView }
  | { kind: 'public'; manifestCid: string; height: number | null; keyFromEvent?: string }
  | { kind: 'publicUnconfirmed'; manifestCid: string | null; height: number | null; detail: string }
  | { kind: 'needManifest' } // encrypted file whose manifest is not on the DSN yet — share prerequisite missing

export function SharePanel({ manifest, registryRecord, getPassphrase, onNotice, onChanged }: SharePanelProps) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active: activeSigner, evm } = useSigner()

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [everSold, setEverSold] = useState(false)
  const [everDisclosed, setEverDisclosed] = useState(false)
  const [price, setPrice] = useState('')
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [pending, setPending] = useState<SalesOrderRow[]>([])
  const [busy, setBusy] = useState(false)

  const withBusy = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true)
      try {
        await fn()
      } catch (e) {
        onNotice(`✗ ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [onNotice],
  )

  const refresh = useCallback(async () => {
    setEverSold(await hasEverSold(manifest.rootCid))
    setEverDisclosed(await hasEverDisclosed(manifest.rootCid))
    const attempted = await hasDisclosureAttempted(manifest.rootCid)
    const metaPub = await getManifestPublishMeta(manifest.rootCid)
    const manifestCid = registryRecord?.manifestCid ?? metaPub?.manifestCid ?? null
    const height = registryRecord?.height ?? metaPub?.height ?? null
    if (manifest.encryption == null) {
      setPhase({ kind: 'plain' })
      return
    }
    if (!manifestCid) {
      setPhase({ kind: 'needManifest' })
      return
    }
    try {
      const published = publicPublisherActive() ? await fetchPublishedByKey(manifestCid) : null
      if (published) {
        setPhase({ kind: 'public', manifestCid, height, keyFromEvent: published.key })
        setPending(publicPublisherActive() && evm ? await fetchSellerOrdersSales(evm.address).then((rows) => rows.filter((r) => r.entry?.manifestCid === manifestCid)) : [])
        return
      }
      if (attempted) {
        // Broadcast happened but no event visible — public (unconfirmed),
        // never falls back to unshared
        setPhase({ kind: 'publicUnconfirmed', manifestCid, height, detail: '' })
        return
      }
      const listing = evm ? await getListingSales(evm.address, manifestCid) : null
      if (listing && listing.price > 0n) {
        setPhase({ kind: 'paid', manifestCid, height, listing })
        setPending(evm ? await fetchSellerOrdersSales(evm.address).then((rows) => rows.filter((r) => r.entry?.manifestCid === manifestCid)) : [])
        return
      }
      setPhase({ kind: 'unshared', manifestCid, height })
    } catch {
      // Derivation failure renders as unshared (never impersonates public;
      // reopening the panel retries)
      setPhase({ kind: 'unshared', manifestCid, height })
    }
  }, [manifest, registryRecord, evm])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---- Put the manifest itself on the DSN (share prerequisite; Registry
  // registration stays optional and is NOT done here) ----

  const ensureManifestPrepared = async (): Promise<ManifestPublicationMeta> => {
    if (registryRecord) return { manifestCid: registryRecord.manifestCid, height: registryRecord.height, txHash: '' }
    const meta = await getManifestPublishMeta(manifest.rootCid)
    if (meta) return meta
    if (!activeSigner) throw new Error(t('files.needSubstrate'))
    const api = await connect()
    onNotice(t('share.publishingManifest'))
    const publication = await publishManifestToChain(api, manifest, activeSigner)
    await putManifestPublishMeta(manifest.rootCid, publication)
    return { manifestCid: publication.manifestCid, height: publication.height, txHash: publication.txHash }
  }

  // ---- For sale ----

  const listNow = () =>
    withBusy(async () => {
      if (!evm) return
      const p = phase.kind === 'paid' || phase.kind === 'unshared' ? phase : null
      if (!p?.manifestCid) return
      const wei = BigInt(Math.round(Number(price) * 1e18))
      if (wei <= 0n) return
      await createRevisionSales(evm, p.manifestCid, wei)
      onNotice(t('sales.listedOk', [price]))
      setPrice('')
      await refresh()
      onChanged()
    })

  // ---- Delist (buyers keep their K) ----

  const unlist = () =>
    withBusy(async () => {
      if (!evm || phase.kind !== 'paid') return
      // Copies sold = unique buyer addresses (for-sale files have no publisher
      // purchase, so the count is trustworthy)
      let buyers = 0
      try {
        const r = await getRatingSales(evm.address, phase.manifestCid)
        buyers = Number(r.buyers)
      } catch {
        /* read failure does not block delisting; only the history marker is lost */
      }
      if (!window.confirm(t('share.delistConfirm', [String(buyers)]))) return
      await delistSales(evm, phase.manifestCid)
      if (buyers > 0) await markEverSold(manifest.rootCid)
      onNotice(t('sales.unlistedOk', [manifest.file.name]))
      await refresh()
      onChanged()
    })

  // ---- Make public (dust price + Published event; disclosure semantics:
  //  broadcast counts as publishing) ----

  const doPublish = () =>
    withBusy(async () => {
      if (!evm) return
      const prep = await ensureManifestPrepared()
      if (!manifest.encryption) throw new Error(t('errors.manifestNotEncrypted'))
      const keyBytes = await unwrapManifestKey(evm, manifest, getPassphrase)
      // 1 wei listing (re-pricing = a new immutable revision; sold orders are
      // unaffected); reuse when the price is already 1 wei
      let listing = await getListingSales(evm.address, prep.manifestCid)
      if (!listing || listing.price !== 1n) {
        await createRevisionSales(evm, prep.manifestCid, 1n)
        listing = await getListingSales(evm.address, prep.manifestCid)
      }
      if (!listing || listing.price !== 1n) throw new Error(t('share.listingOneWeiFailed'))
      // Persist the disclosure marker BEFORE handing the signature request to
      // the wallet (broadcast) — propagation is disclosure
      await markEverDisclosed(manifest.rootCid)
      await markDisclosureAttempted(manifest.rootCid)
      try {
        await publishPublic(evm, {
          manifestCid: prep.manifestCid,
          expectedRevision: listing.revision,
          keyBytes,
          plainSha256: manifest.file.sha256,
          plainSize: manifest.file.size,
          manifestHeightHint: prep.height ?? 0,
        })
      } catch (e) {
        if (isUserRejected(e)) {
          // Only "signature never happened" (user rejected) keeps the prior state
          await unmarkDisclosureAttempted(manifest.rootCid)
          onNotice(t('share.publishRejected'))
          return
        }
        onNotice(t('share.publicUnconfirmedNotice'))
        await refresh()
        onChanged()
        return
      }
      onNotice(t('share.publishedOk'))
      await refresh()
      onChanged()
    })

  const askPublish = () => {
    if (!publicPublisherActive()) {
      onNotice(t('errors.publicPublisherNotConfigured'))
      return
    }
    setConfirmPublic(true)
  }

  // ---- Copy public link (contains k — a disclosure act in its own right) ----

  const copyPublicLink = () =>
    withBusy(async () => {
      if (!evm) return
      const p = phase.kind === 'public' || phase.kind === 'publicUnconfirmed' ? phase : null
      if (!p) return
      const prep = await ensureManifestPrepared()
      const keyBytes = await unwrapManifestKey(evm, manifest, getPassphrase)
      const link = buildShareLink({
        manifestCid: prep.manifestCid,
        height: prep.height,
        owner: evm.address,
        key: keyHex(keyBytes),
      })
      await navigator.clipboard.writeText(link)
      await markEverDisclosed(manifest.rootCid)
      setEverDisclosed(true)
      onNotice(t('share.linkCopied'))
    })

  // ---- Orders to deliver (seller actions live in the panel) ----

  const deliver = (row: SalesOrderRow) =>
    withBusy(async () => {
      if (!evm) return
      onNotice(t('sales.delivering', [row.buyer.slice(0, 8) + '…']))
      const r = await deliverKeySales(evm, row.entry!.manifestCid, manifest, row.buyer, row.orderId, row.provider, getPassphrase)
      onNotice(t('sales.deliveredOk', [row.buyer.slice(0, 8) + '…', r.deliveredTxHash.slice(0, 14) + '…']))
      await refresh()
    })

  const stateLine = (() => {
    switch (phase.kind) {
      case 'loading':
        return t('share.loading')
      case 'plain':
        return t('share.statePlain')
      case 'unshared':
        return t('share.stateUnshared')
      case 'paid':
        return t('share.statePaid', [formatAi3(phase.listing.price)])
      case 'public':
        return t('share.statePublic')
      case 'publicUnconfirmed':
        return t('share.statePublicUnconfirmed')
      case 'needManifest':
        return t('share.needManifest')
    }
  })()

  const needEvm = phase.kind !== 'loading' && phase.kind !== 'plain' && !evm

  return (
    <div className="share-panel">
      <div className="card-head">
        <h3>
          {t('share.panelTitle', [manifest.file.name])}{' '}
          <ChainTag chain="evm" />
        </h3>
      </div>
      <p className="privacy-note">{stateLine}</p>

      {everSold && <div className="notice">{t('share.everSoldNote')}</div>}
      {everDisclosed && <div className="notice">{t('share.everDisclosedNote')}</div>}
      {needEvm && <div className="notice">{t('share.needEvm')}</div>}
      {phase.kind === 'needManifest' && <div className="notice">{t('share.needManifestNote')}</div>}

      {phase.kind === 'unshared' && (
        <>
          <div className="kv">
            <span>{t('sales.priceLabel')}</span>
            <input type="number" min="0" step="0.001" placeholder="0.05" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          {price && Number(price) > 0 && (
            <p className="muted small-text">{t('sales.netPreview', ['10', formatAi3((BigInt(Math.round(Number(price) * 1e18)) * 9n) / 10n)])}</p>
          )}
          <div className="row">
            <button className="btn small primary" disabled={busy || !price || Number(price) <= 0 || !phase.manifestCid || !evm} onClick={() => void listNow()}>
              {t('share.listForSale')}
            </button>
            <button className="btn small" disabled={busy || !evm || !manifest.encryption} onClick={() => void askPublish()}>
              {t('share.publishPublic')}
            </button>
          </div>
          <p className="muted small-text">
            {phase.manifestCid ? t('share.unsharedHint') : t('share.needManifestFirst')}
          </p>
        </>
      )}

      {phase.kind === 'paid' && (
        <>
          <div className="row">
            <button className="btn ghost small" disabled={busy || !evm} onClick={() => void unlist()}>
              {t('share.delist')}
            </button>
            <button className="btn small" disabled={busy || !evm || !manifest.encryption} onClick={() => void askPublish()}>
              {t('share.publishPublic')}
            </button>
          </div>
          <p className="muted small-text">{t('share.paidHint')}</p>
        </>
      )}

      {(phase.kind === 'public' || phase.kind === 'publicUnconfirmed') && (
        <>
          <div className="row">
            <button className="btn small" disabled={busy || !evm || !manifest.encryption} onClick={() => void copyPublicLink()}>
              {t('share.copyPublicLink')}
            </button>
            {phase.kind === 'publicUnconfirmed' && (
              <button className="btn small primary" disabled={busy || !evm || !manifest.encryption} onClick={() => void askPublish()}>
                {t('share.retryPublish')}
              </button>
            )}
          </div>
          <p className="muted small-text">{phase.kind === 'public' ? t('share.publicHint') : t('share.publicUnconfirmedHint')}</p>
        </>
      )}

      {pending.length > 0 && (
        <>
          <h3 className="share-subhead">{t('sales.pendingOrders')}</h3>
          <table className="files-table">
            <tbody>
              {pending.map((row) => (
                <tr key={`sp-${row.orderId}`}>
                  <td>
                    <div className="mono small-text muted">{row.buyer.slice(0, 10)}…{row.buyer.slice(-6)}</div>
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
        </>
      )}

      {confirmPublic && (
        <div className="confirm-panel">
          <p className="warning">{t('share.publicConfirmWarning')}</p>
          <p className="warning">{t('share.publicConfirmBroadcast')}</p>
          <p className="muted small-text">{t('share.publicConfirmCost')}</p>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => { setConfirmPublic(false); void doPublish() }}>
              {t('share.publishConfirm')}
            </button>
            <button className="btn ghost" onClick={() => setConfirmPublic(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
