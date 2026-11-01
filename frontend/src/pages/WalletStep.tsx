import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

export type RunWalletAction = <T>(label: string, detail: string, action: () => Promise<T>) => Promise<T>
interface Step {
  label: string
  detail: string
  status: 'ready' | 'waiting' | 'done' | 'error'
  progress?: string
  error?: string
}

/** Keep the step visible throughout the actual wallet operation and confirmation. */
export function useWalletStep() {
  const pending = useRef<{ start: () => void; reject: (error: Error) => void; running: boolean } | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  useEffect(() => () => {
    pending.current?.reject(new Error(t('walletSteps.cancelled')))
    pending.current = null
  }, [])
  const runWalletAction: RunWalletAction = (label, detail, action) => new Promise((resolve, reject) => {
    if (pending.current) { reject(new Error(t('walletSteps.busy'))); return }
    const request = {
      running: false,
      reject,
      start: () => {
        if (pending.current !== request || request.running) return
        request.running = true
        setStep({ label, detail, status: 'waiting' })
        void Promise.resolve().then(action).then((result) => {
          if (pending.current !== request) return
          pending.current = null
          setStep({ label, detail, status: 'done' })
          resolve(result)
        }, (error: unknown) => {
          if (pending.current !== request) return
          pending.current = null
          setStep({ label, detail, status: 'error', error: error instanceof Error ? error.message : String(error) })
          reject(error)
        })
      },
    }
    pending.current = request
    setStep({ label, detail, status: 'ready' })
  })
  useEffect(() => {
    if (step?.status === 'ready') document.querySelector('[data-testid="wallet-step"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [step])
  const cancel = () => {
    if (pending.current?.running) return
    pending.current?.reject(new Error(t('walletSteps.cancelled')))
    pending.current = null
    setStep(null)
  }
  const updateWalletProgress = (progress: string) => setStep((current) => current?.status === 'waiting' ? { ...current, progress } : current)
  const walletStep = step && <section className="card" role="region" aria-label={t(step.status === 'ready' ? 'walletSteps.title' : 'walletSteps.currentTitle')} data-testid="wallet-step" data-status={step.status}>
    <h3>{t(step.status === 'ready' ? 'walletSteps.title' : 'walletSteps.currentTitle')}</h3>
    <p>{step.detail}</p>
    <div className="row">
      <button className="btn primary" disabled={step.status !== 'ready'} aria-busy={step.status === 'waiting'} onClick={() => pending.current?.start()}>
        {step.label}{step.status === 'waiting' ? ` · ${t('walletSteps.waiting')}` : step.status === 'done' ? ` · ${t('walletSteps.done')}` : step.status === 'error' ? ` · ${t('walletSteps.failed')}` : ''}
      </button>
      {step.status !== 'waiting' && <button className="btn ghost" onClick={cancel}>{t(step.status === 'ready' ? 'common.cancel' : 'common.close')}</button>}
    </div>
    {step.status === 'waiting' && <p role="status">{step.progress || t('walletSteps.waitingHelp')}</p>}
    {step.status === 'error' && <p className="error-text" role="alert">{step.error}</p>}
  </section>
  return { runWalletAction, walletStep, updateWalletProgress }
}
