// File list (presentational): archive progress (indexer mapping task),
// on-chain registry status, the three-state share badge (unshared / for-sale /
// public) and row actions. The action callbacks are injected by FilesPage
// (download / export manifest / sync to registry / delete / share panel).

import { formatBytes } from '../lib/bytes'
import type { Manifest } from '../lib/manifest'
import type { TaskRecord } from '../lib/store'
import type { ShareInfo } from '../lib/shareState'
import { useI18n } from '../i18n'

interface FilesTableProps {
  manifests: Manifest[]
  taskByRoot: Map<string, TaskRecord>
  rowBusy: Record<string, string>
  syncedRootCids: Set<string>
  syncing: Set<string>
  shareInfoByRoot: Map<string, ShareInfo>
  sharePanelRoot: string | null
  onDownload: (m: Manifest) => void
  onExport: (m: Manifest) => void
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

export function FilesTable({
  manifests,
  taskByRoot,
  rowBusy,
  syncedRootCids,
  syncing,
  shareInfoByRoot,
  sharePanelRoot,
  onDownload,
  onExport,
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
          <th>{t('files.thRegistry')}</th>
          <th>{t('files.thShare')}</th>
          <th>{t('files.thPublished')}</th>
          <th>{t('common.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {manifests.map((m) => {
          const task = taskByRoot.get(m.rootCid)
          const badge = shareBadge(shareInfoByRoot.get(m.rootCid), t)
          return (
            <tr key={m.rootCid}>
              <td>
                <div className="file-name">
                  {m.encryption ? '🔒 ' : ''}
                  {m.file.name}
                </div>
                <div className="mono small-text muted">{m.rootCid.slice(0, 24)}…</div>
                {rowBusy[m.rootCid] && <div className="small-text row-status">{rowBusy[m.rootCid]}</div>}
              </td>
              <td>{formatBytes(m.file.size)}</td>
              <td>
                {!task ? (
                  <span className="muted">{t('files.archiveUnknown')}</span>
                ) : task.done ? (
                  <span className="ok">{t('files.archived')}</span>
                ) : (
                  <span>
                    {task.indexed}/{task.total} {t('files.indexed')}
                  </span>
                )}
              </td>
              <td>
                {syncedRootCids.has(m.rootCid) ? (
                  <span className="ok">{t('files.registered')}</span>
                ) : (
                  <span className="muted">{t('files.notRegistered')}</span>
                )}
              </td>
              <td>
                <span
                  className="share-badge"
                  title={t('share.badgeHint')}
                >
                  {badge.icon} {badge.label}
                </span>
              </td>
              <td className="small-text">{new Date(m.submittedAt).toLocaleString()}</td>
              <td>
                <div className="row-actions">
                  <button className="btn small" onClick={() => onDownload(m)}>
                    {t('common.download')}
                  </button>
                  <button className={`btn ghost small ${sharePanelRoot === m.rootCid ? 'active' : ''}`} onClick={() => onShare(m)}>
                    {t('files.shareBtn')}
                  </button>
                  <button className="btn ghost small" onClick={() => onExport(m)}>
                    {t('files.manifestBtn')}
                  </button>
                  <button className="btn ghost small" onClick={() => onSync(m)} disabled={syncing.has(m.rootCid)}>
                    {t('files.syncRegistry')}
                  </button>
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
