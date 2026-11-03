// File table (presentational): archive progress (indexer mapping task),
// on-chain registry status, the three-state share badge (unshared / for-sale /
// public) and row actions. The action callbacks are injected by FilesPage
// (download / export manifest / sync to registry / hide / share panel).
// Version grouping (2026-11-03): same-owner same-name files form a version
// chain — the main row shows only the latest version (vN badge), history
// versions live in an expandable sub-table (downloadable); "overwrite" is only
// a directory view, all versions stay on-chain forever at the data layer.
// Hide (2026-11-03): the hide mark lives in the FileState contract (recovery
// on a new device lands it in the hidden group automatically); groups whose
// latest version is hidden are hidden by default, and the "show hidden" toggle
// makes them visible (dimmed).

import { useState } from 'react'
import { formatBytes } from '../lib/bytes'
import { groupFileVersions } from '../lib/fileVersions'
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
  /** groups whose latest version is hidden are not rendered by default;
   *  the showHidden toggle reveals them dimmed */
  hiddenRootCids: Set<string>
  showHidden: boolean
  /** false when the FileState contract is not configured — no Hide/Unhide buttons */
  hideEnabled: boolean
  onDownload: (m: Manifest) => void
  onSync: (m: Manifest) => void
  onHide: (m: Manifest) => void
  onUnhide: (m: Manifest) => void
  onShare: (m: Manifest) => void
}

// Badges (unshared / for-sale / public; plaintext = born public). "Public
// (unconfirmed)" is expressed by shareState as kind='public' +
// disclosureAttempted, same badge.
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
  hiddenRootCids,
  showHidden,
  hideEnabled,
  onDownload,
  onSync,
  onHide,
  onUnhide,
  onShare,
}: FilesTableProps) {
  const { t } = useI18n()
  if (manifests.length === 0) return <p className="muted">{t('files.empty')}</p>
  // version grouping: same name = one group, latest = last element (highest
  // height); groups whose latest is hidden are not rendered unless showHidden
  const groups = groupFileVersions(manifests).filter((g) => showHidden || !hiddenRootCids.has(g.latest.rootCid))
  if (groups.length === 0) return <p className="muted">{t('files.allHidden')}</p>
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
        {groups.map((g) => {
          const m = g.latest
          const version = g.versions.length
          // history versions (newest first): v{n-1}…v1; display + download only
          // (hide/unhide applies to the latest version only)
          const history = g.versions.slice(0, -1).reverse()
          const isHidden = hiddenRootCids.has(m.rootCid)
          const registrations = registryRecords.filter((record) => record.rootCid === m.rootCid)
          const complete = syncedRootCids.has(m.rootCid)
          const task = taskByRoot.get(m.rootCid)
          const badge = shareBadge(shareInfoByRoot.get(m.rootCid), t)
          return (
            <FragmentGroup
              key={m.rootCid}
              m={m}
              version={version}
              history={history}
              isHidden={isHidden}
              registrations={registrations}
              complete={complete}
              task={task}
              badge={badge}
              rowBusy={rowBusy}
              syncedRootCids={syncedRootCids}
              syncing={syncing}
              canSync={canSync}
              sharePanelRoot={sharePanelRoot}
              hideEnabled={hideEnabled}
              onDownload={onDownload}
              onSync={onSync}
              onHide={onHide}
              onUnhide={onUnhide}
              onShare={onShare}
            />
          )
        })}
      </tbody>
    </table>
  )
}

// one group = main row + expandable history row; a separate component keeps
// the hooks (FileHash) and structure readable
function FragmentGroup({
  m,
  version,
  history,
  isHidden,
  registrations,
  complete,
  task,
  badge,
  rowBusy,
  syncedRootCids,
  syncing,
  canSync,
  sharePanelRoot,
  hideEnabled,
  onDownload,
  onSync,
  onHide,
  onUnhide,
  onShare,
}: {
  m: Manifest
  version: number
  history: Manifest[]
  isHidden: boolean
  registrations: RegistryRecord[]
  complete: boolean
  task: TaskRecord | undefined
  badge: { icon: string; label: string }
  rowBusy: Record<string, string>
  syncedRootCids: Set<string>
  syncing: Set<string>
  canSync: boolean
  sharePanelRoot: string | null
  hideEnabled: boolean
  onDownload: (m: Manifest) => void
  onSync: (m: Manifest) => void
  onHide: (m: Manifest) => void
  onUnhide: (m: Manifest) => void
  onShare: (m: Manifest) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <tr key={m.rootCid} className={isHidden ? 'hidden-row' : undefined}>
        <td>
          <div className="file-name">
            {m.encryption ? '🔒 ' : ''}
            {m.file.name}
            {version > 1 && <span className="version-badge" title={t('files.versionBadgeTitle', [version])}>v{version}</span>}
            {isHidden && <span className="hidden-badge">{t('files.hiddenBadge')}</span>}
          </div>
          <div className="small-text muted">{m.file.mimeType}</div>
          {m.note && <div className="small-text muted" title={t('files.noteTitle')}>✎ {m.note}</div>}
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
            {hideEnabled && (isHidden
              ? <button className="btn small" onClick={() => onUnhide(m)} title={t('files.unhideTitle')}>{t('files.unhide')}</button>
              : <button className="btn ghost small danger" onClick={() => onHide(m)} title={t('files.hideTitle')}>{t('files.hide')}</button>)}
          </div>
        </td>
      </tr>
      {history.length > 0 && (
        <tr className="history-row">
          <td colSpan={6}>
            <details className="file-details">
              <summary>{t('files.versionHistory', [history.length])}</summary>
              <table className="files-table version-table">
                <thead>
                  <tr>
                    <th>{t('files.versionCol')}</th>
                    <th>{t('files.thPublished')}</th>
                    <th>{t('common.size')}</th>
                    <th>SHA-256</th>
                    <th>{t('files.noteLabel')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((v, i) => (
                    <tr key={v.rootCid}>
                      <td>v{history.length - i}</td>
                      <td className="small-text">{new Date(v.submittedAt).toLocaleString()}</td>
                      <td>{formatBytes(v.file.size)}</td>
                      <td className="mono small-text" title={v.file.sha256}>{v.file.sha256.slice(0, 16)}…{v.file.sha256.slice(-4)}</td>
                      <td className="small-text muted">{v.note ?? '—'}</td>
                      <td>
                        <button className="btn small" onClick={() => onDownload(v)}>{t('common.download')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </td>
        </tr>
      )}
    </>
  )
}
