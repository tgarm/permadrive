// Settings: endpoint overrides (RPC / indexer / throttle interval) and the
// on-chain storage fee rate. Saving disconnects the current connection; the
// next operation reconnects using the new configuration.

import { useState } from 'react'
import { useChain } from '../chain-context'
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AppConfig } from '../lib/config'
import { useI18n } from '../i18n'

export function SettingsPage() {
  const { t } = useI18n()
  const { status, chainName, byteFeeShannons, error, connect, disconnect } = useChain()
  const [form, setForm] = useState<AppConfig>(loadConfig())
  const [saved, setSaved] = useState(false)

  const save = async () => {
    saveConfig(form)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    await disconnect() // takes effect on the next connection
  }

  const reset = async () => {
    setForm({ ...DEFAULT_CONFIG })
    saveConfig({ ...DEFAULT_CONFIG })
    await disconnect()
  }

  const ai3PerMb = byteFeeShannons ? Number((byteFeeShannons * 1048576n) / 10n ** 12n) / 1e6 : null

  return (
    <div className="page">
      <section className="card">
        <h2>{t('settings.networkTitle')}</h2>
        <p className="muted">{t('settings.networkIntro')}</p>
        <label className="field">
          <span>{t('settings.rpcLabel')}</span>
          <input value={form.rpcUrl} onChange={(e) => setForm({ ...form, rpcUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.indexerLabel')}</span>
          <input value={form.indexerUrl} onChange={(e) => setForm({ ...form, indexerUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.intervalLabel')}</span>
          <input
            type="number"
            min={500}
            step={100}
            value={form.minIntervalMs}
            onChange={(e) => setForm({ ...form, minIntervalMs: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>{t('settings.evmRpcLabel')}</span>
          <input value={form.evmRpcUrl} onChange={(e) => setForm({ ...form, evmRpcUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.registryLabel')}</span>
          <input value={form.registryAddress} onChange={(e) => setForm({ ...form, registryAddress: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.paywallLabel')}</span>
          <input value={form.paywallAddress} onChange={(e) => setForm({ ...form, paywallAddress: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.paywallV2Label')}</span>
          <input value={form.paywallV2Address} onChange={(e) => setForm({ ...form, paywallV2Address: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('settings.salesLabel')}</span>
          <input value={form.salesAddress} onChange={(e) => setForm({ ...form, salesAddress: e.target.value })} spellCheck={false} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={() => void save()}>
            {t('settings.save')}
          </button>
          <button className="btn ghost" onClick={() => void reset()}>
            {t('settings.reset')}
          </button>
          {saved && <span className="ok">{t('settings.saved')}</span>}
        </div>
      </section>

      <section className="card">
        <h2>{t('settings.chainTitle')}</h2>
        <div className="kv">
          <span>{t('settings.connection')}</span>
          <span>
            {status === 'ready' ? (
              <span className="ok">✓ {chainName}</span>
            ) : status === 'connecting' ? (
              t('settings.connecting')
            ) : status === 'error' ? (
              <span className="error-text">{t('settings.failed')}</span>
            ) : (
              t('settings.notConnected')
            )}
          </span>
        </div>
        <div className="kv">
          <span>{t('settings.feeRate')}</span>
          <span>{ai3PerMb != null ? t('settings.feeRateValue', [ai3PerMb.toFixed(2)]) : '—'}</span>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="row">
          <button className="btn ghost small" onClick={() => void connect().catch(() => undefined)}>
            {t('settings.testConnection')}
          </button>
        </div>
      </section>
    </div>
  )
}
