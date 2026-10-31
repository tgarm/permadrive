// File list (presentational): archive progress (indexer mapping task),
// on-chain registry status and row actions. The action callbacks are injected
// by FilesPage (download / export manifest / sync to registry / delete).

import { formatBytes } from '../lib/bytes'
import type { Manifest } from '../lib/manifest'
import type { TaskRecord } from '../lib/store'
import { useI18n } from '../i18n'

interface FilesTableProps {
  manifests: Manifest[]
  taskByRoot: Map<string, TaskRecord>
  rowBusy: Record<string, string>
  syncedRootCids: Set<string>
  syncing: Set<string>
  onDownload: (m: Manifest) => void
  onExport: (m: Manifest) => void
  onSync: (m: Manifest) => void
  onDelete: (m: Manifest) => void
}

export function FilesTable({ manifests, taskByRoot, rowBusy, syncedRootCids, syncing, onDownload, onExport, onSync, onDelete }: FilesTableProps) {
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
          <th>{t('files.thPublished')}</th>
          <th>{t('common.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {manifests.map((m) => {
          const task = taskByRoot.get(m.rootCid)
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
              <td className="small-text">{new Date(m.submittedAt).toLocaleString()}</td>
              <td>
                <div className="row-actions">
                  <button className="btn small" onClick={() => onDownload(m)}>
                    {t('common.download')}
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
