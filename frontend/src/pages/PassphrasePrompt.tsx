// Passphrase fallback dialog (promise-based): when the signature channel
// fails to unwrap, the decrypting side suspends a Promise through
// FilesPage.openPassphrasePrompt and mounts this component; the typed
// passphrase (or a cancel) flows back through onResolve.

import { useState } from 'react'
import { useI18n } from '../i18n'

export interface PassphraseRequest {
  resolve: (value: string | null) => void
}

// the prompt prop itself is never read (being mounted means there is a
// pending request); it only matters that the parent renders conditionally
export function PassphrasePrompt({ onResolve }: { prompt: PassphraseRequest; onResolve: (value: string | null) => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  return (
    <div className="modal-overlay" onMouseDown={() => onResolve(null)}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('files.passphrasePromptTitle')}</h3>
        <p className="muted small-text">{t('files.passphrasePromptBody')}</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value) onResolve(value)
          }}
        />
        <div className="row">
          <button className="btn primary" disabled={!value} onClick={() => onResolve(value)}>
            {t('common.ok')}
          </button>
          <button className="btn ghost" onClick={() => onResolve(null)}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
