import { useI18n } from '../i18n'

interface Props {
  keyPrepared: boolean
  recoveryConnected: boolean
  fileName: string | null
  backedUp: boolean
  busy: boolean
  verified: boolean
  onUpload: () => void
  onVerify: () => void
}

export function FirstUseGuide(p: Props) {
  const { t } = useI18n()
  const done = [p.keyPrepared, !!p.fileName, p.backedUp, p.verified]
  return (
    <section className="card" data-testid="first-use-guide" aria-label={t('onboarding.title')}>
      <h2>{t('onboarding.title')}</h2>
      <p>{t('onboarding.intro')}</p>
      <ol className="storage-steps">
        {['wallet', 'upload', 'backup', 'verify'].map((key, i) => (
          <li key={key} className={done[i] ? 'is-done' : ''}>
            <span className="storage-step-number" aria-hidden="true">{done[i] ? '✓' : i + 1}</span>
            <div><strong>{t(`onboarding.${key}`)}</strong>
              <p>{t(`onboarding.${key}Help`)}</p>
              <span className="muted">{t(done[i] ? 'onboarding.done' : 'onboarding.pending')}</span>
            </div>
          </li>
        ))}
      </ol>
      <p>{t(p.recoveryConnected ? 'onboarding.recoveryReady' : 'onboarding.recoveryMissing')}</p>
      {p.fileName && <p>{t('onboarding.selected', [p.fileName])}</p>}
      <div className="row">
        <button className="btn primary" onClick={p.onUpload}>{t('onboarding.start')}</button>

        {p.backedUp && <button className="btn small" disabled={p.busy} onClick={p.onVerify}>{t('onboarding.verifyAction')}</button>}
      </div>
      <p className="muted">{t('onboarding.sessionNotice')}</p>
    </section>
  )
}
