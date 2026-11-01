// File list (presentational): archive progress (indexer mapping task),
// on-chain registry status, the three-state share badge (unshared / for-sale /
// public) and row actions. The action callbacks are injected by FilesPage
// (download / export manifest / sync to registry / delete / share panel).

import { useState } from 'react'
import { formatBytes } from '../lib/bytes'
import type { Manifest } from '../lib/manifest'
import type { RegistryRecord, TaskRecord } from '../lib/store'
import type { ShareInfo } from '../lib/shareState'
import { useI18n } from '../i18n'

interface FilesTableProps {
  manifests: Manifest[]
  registryRecords: RegistryRecord[]
  taskByRoot: Map<string, TaskRecord>
  rowBusy: Record<string, string>
  syncedRootCids: Set<string>
  canSync: boolean
  syncing: Set<string>
  shareInfoByRoot: Map<string, ShareInfo>
  sharePanelRoot: string | null
  onDownload: (m: Manifest) => void
  onSync: (m: Manifest) => void
  onDelete: (m: Manifest) => void
  onShare: (m: Manifest) => void
}

// Badges (unshared / for-sale / public; plaintext = born public). "Public
// (unconfirmed)" is expressed by shareState as kind='public' +
// disclosureAttempted; the badge is the same globe.
function shareBadge(info: ShareInfo | undefined, t: (k: string) => string): { icon: string; label: string } {
  if (!info) return { icon: '🔒', label: t('share.badge.unshared') }
  switch (info.kind) {
    case 'plain':
      return { icon: '🌐', label: t('share.badge.plain') }
    case 'paid':
      return { icon: '💰', label: t('share.badge.paid') }
    case 'public':
      return info.disclosureAttempted ? { icon: '🌐', label: t('share.badge.publicUnconfirmed') } : { icon: '🌐', label: t('share.badge.public') }
    default:
      return { icon: '🔒', label: t('share.badge.unshared') }
  }
}

function FileHash({ value }: { value: string }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const click = async () => {
    if (!expanded) { setExpanded(true); return }
    try { await navigator.clipboard.writeText(value); setResult(t('files.hashCopied')) }
    catch { setResult(t('files.hashCopyFailed')) }
  }
  return <div className="file-hash">
    <span className="muted small-text">{t('files.originalHash')}</span>
    <button className="btn ghost small mono hash-button" title={t(expanded ? 'files.hashCopy' : 'files.hashExpand')} onClick={() => void click()}>{expanded ? value : `${value.slice(0, 12)}…${value.slice(-8)}`}</button>
    <span role="status" className="small-text">{result}</span>
  </div>
}

export function FilesTable({
  manifests,
  registryRecords,
  taskByRoot,
  rowBusy,
  syncedRootCids,
  syncing,
  canSync,
  shareInfoByRoot,
  sharePanelRoot,
  onDownload,
  onSync,
  onDelete,
  onShare,
}: FilesTableProps) {
  const { t } = useI18n()
  if (manifests.length === 0) return <p className="muted">{t('files.empty')}</p>
  return (
    <table className="files-table">
      <thead>
        <tr>
          <th>{t('files.thFile')}</th>
          <th>{t('common.size')}</th>
          <th>{t('files.thDsn')}</th>
          <th>{t('files.saveStatus')}</th>
          <th>{t('files.thShare')}</th>
          <th>{t('common.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {manifests.map((m) => {
          const registrations = registryRecords.filter((record) => record.rootCid === m.rootCid)
          const complete = syncedRootCids.has(m.rootCid)
          const task = taskByRoot.get(m.rootCid)
          const badge = shareBadge(shareInfoByRoot.get(m.rootCid), t)
          return (
            <tr key={m.rootCid}>
              <td>
                <div className="file-name">
                  {m.encryption ? '🔒 ' : ''}
                  {m.file.name}
                </div>
                <div className="small-text muted">{m.file.mimeType}</div>
                {!syncedRootCids.has(m.rootCid) && <FileHash value={m.file.sha256} />}
                {rowBusy[m.rootCid] && (!complete || syncing.has(m.rootCid)) && <div className="small-text row-status">{rowBusy[m.rootCid]}</div>}
              </td>
              <td>{formatBytes(m.file.size)}</td>
              <td>
                <span role="img" tabIndex={0} className={task?.done ? 'ok file-status-icon' : 'muted file-status-icon'} aria-label={t(!task ? 'files.archiveUnknown' : task.done ? 'files.archived' : 'files.archiving')} title={!task ? t('files.archiveUnknown') : task.done ? t('files.archived') : `${t('files.archiving')} ${task.indexed}/${task.total}`}>{!task ? '○' : task.done ? '✓' : '◷'}</span>
              </td>
              <td>
                <span role="img" tabIndex={0} className={complete ? 'ok file-status-icon' : 'file-status-icon'} aria-label={t(complete ? 'files.saveComplete' : 'files.saveIncomplete')} title={t(complete ? 'files.saveComplete' : 'files.saveIncomplete')}>{complete ? '✓' : '◷'}</span>
              </td>
              <td><span role="img" tabIndex={0} className="share-badge" aria-label={badge.label} title={badge.label}>{badge.icon}</span></td>
              <td>
                <div className="row-actions">
                  {syncedRootCids.has(m.rootCid) ? <>
                    <button className="btn small" onClick={() => onDownload(m)}>{t('common.download')}</button>
                    <button className={`btn ghost small ${sharePanelRoot === m.rootCid ? 'active' : ''}`} onClick={() => onShare(m)}>{t('files.shareBtn')}</button>
                  </> : <button className="btn primary small" onClick={() => onSync(m)} disabled={!canSync || syncing.has(m.rootCid)} aria-busy={syncing.has(m.rootCid)}>{t(syncing.has(m.rootCid) ? 'walletSteps.waiting' : 'onboarding.resume')}</button>}
                  <details className="file-details">
                    <summary>{t('files.details')}</summary>
                    <dl>
                      <dt>CID</dt><dd className="mono">{m.rootCid}</dd>
                      <dt>{t('files.thPublished')}</dt><dd>{new Date(m.submittedAt).toLocaleString()}</dd>
                      <dt>{t('common.size')}</dt><dd>{m.file.size.toLocaleString()} B</dd>
                      {complete && <><dt>SHA-256</dt><dd className="mono">{m.file.sha256}</dd></>}
                      {m.txs.map((tx) => <div key={tx.txHash}><dt>{t('files.storageTransaction')}</dt><dd className="mono">#{tx.height} · {tx.txHash}</dd></div>)}
                      {registrations.map((record) => <div key={record.evmAddress}><dt>{t('files.indexDetails')}</dt><dd className="mono">{record.evmAddress}<br />{record.manifestCid}<br />#{record.height}</dd></div>)}
                      {complete && rowBusy[m.rootCid] && <><dt>{t('files.lastResult')}</dt><dd>{rowBusy[m.rootCid]}</dd></>}
                    </dl>
                  </details>
                  <button className="btn ghost small danger" onClick={() => onDelete(m)}>
                    {t('common.delete')}
                  </button>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
