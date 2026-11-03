// Site-wide confirmation dialog (promise-based, the destructive-action carrier
// required by the UI style guide): replaces native window.confirm everywhere.
// Destructive actions (hide/delete/delist/overwrite-export) pass danger to
// render the confirm button with the red .btn.danger style; Esc / overlay
// click = cancel. Pages wire it via useConfirmDialog() (returns openConfirm +
// the dialog node); call sites read `if (!(await openConfirm(...))) return`.

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest; onResolve: (ok: boolean) => void }) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])
  return (
    <div className="modal-overlay" onMouseDown={() => onResolve(false)}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{request.title}</h3>
        {request.body && <p className="muted small-text">{request.body}</p>}
        <div className="row">
          <button className={`btn ${request.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => onResolve(true)}>
            {request.confirmLabel}
          </button>
          <button className="btn ghost" onClick={() => onResolve(false)}>
            {request.cancelLabel ?? t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
}

/** Page wiring: `const { openConfirm, dialog } = useConfirmDialog()`, render {dialog} in JSX */
export function useConfirmDialog(): {
  openConfirm: (opts: ConfirmOptions) => Promise<boolean>
  dialog: React.ReactNode
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const openConfirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...opts, resolve })),
    [],
  )
  const dialog = request ? (
    <ConfirmDialog
      request={request}
      onResolve={(ok) => {
        request.resolve(ok)
        setRequest(null)
      }}
    />
  ) : null
  return { openConfirm, dialog }
}
