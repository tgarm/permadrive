// Publish-results-pending-verification notice (R02): rescan by hash on unknown
// results and recover the manifest — never auto-resend; "Dismiss" deletes the
// hash-based recovery handle.

import type { PublishTaskRecord } from '../lib/store'
import { useI18n } from '../i18n'

interface PendingPublishNoticeProps {
  records: PublishTaskRecord[]
  verifyingId: string | null
  onVerify: (record: PublishTaskRecord) => void
  onDismiss: (record: PublishTaskRecord) => void
}

export function PendingPublishNotice({ records, verifyingId, onVerify, onDismiss }: PendingPublishNoticeProps) {
  const { t } = useI18n()
  if (records.length === 0) return null
  return (
    <div className="notice">
      <div>{t('publishPending.title', [String(records.length)])}</div>
      {records.map((p) => (
        <div key={p.id} className="row" style={{ alignItems: 'center', gap: 8 }}>
          <span className="muted small-text">
            {t('publishPending.detail', [p.file.name, String(p.txHashes.length), String(p.startHeight)])}
          </span>
          <button className="btn small" disabled={verifyingId === p.id} onClick={() => onVerify(p)}>
            {verifyingId === p.id ? t('publishPending.verifying') : t('publishPending.verify')}
          </button>
          <button className="btn ghost small" disabled={verifyingId === p.id} onClick={() => onDismiss(p)}>
            {t('publishPending.dismiss')}
          </button>
        </div>
      ))}
    </div>
  )
}
