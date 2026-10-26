// Settings: endpoint overrides (RPC / indexer / throttle interval) and the
// on-chain storage fee rate. Saving disconnects the current connection; the
// next operation reconnects using the new configuration.

import { useState } from 'react'
import { useChain } from '../chain-context'
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AppConfig } from '../lib/config'

export function SettingsPage() {
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
        <h2>Network &amp; endpoints</h2>
        <p className="muted">
          Manifests only record the network identifier (mainnet); endpoints are this app's configuration — switching
          endpoints does not affect retrieving existing files. Public RPC endpoints rate-limit; the default minimum
          interval between consecutive requests is ≥1.6s.
        </p>
        <label className="field">
          <span>Consensus chain RPC (HTTP)</span>
          <input value={form.rpcUrl} onChange={(e) => setForm({ ...form, rpcUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>object-mapping indexer (WSS)</span>
          <input value={form.indexerUrl} onChange={(e) => setForm({ ...form, indexerUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>Minimum RPC request interval (ms)</span>
          <input
            type="number"
            min={500}
            step={100}
            value={form.minIntervalMs}
            onChange={(e) => setForm({ ...form, minIntervalMs: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Auto-EVM RPC (on-chain registry)</span>
          <input value={form.evmRpcUrl} onChange={(e) => setForm({ ...form, evmRpcUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>FileRegistry v2 contract address (on-chain registry · dev fee applies)</span>
          <input value={form.registryAddress} onChange={(e) => setForm({ ...form, registryAddress: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>FileRegistry v1 contract address (read-only · legacy registry migration)</span>
          <input
            value={form.registryV1Address}
            onChange={(e) => setForm({ ...form, registryV1Address: e.target.value })}
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
          <button className="btn ghost" onClick={() => void reset()}>
            Reset to defaults
          </button>
          {saved && <span className="ok">Saved (takes effect on next connection)</span>}
        </div>
      </section>

      <section className="card">
        <h2>Chain status</h2>
        <div className="kv">
          <span>Connection</span>
          <span>
            {status === 'ready' ? <span className="ok">✓ {chainName}</span> : status === 'connecting' ? 'Connecting…' : status === 'error' ? <span className="error-text">Failed</span> : 'Not connected (connects automatically on first use)'}
          </span>
        </div>
        <div className="kv">
          <span>On-chain storage fee rate</span>
          <span>{ai3PerMb != null ? `≈ ${ai3PerMb.toFixed(2)} AI3 / MB (live transactionByteFee value)` : '—'}</span>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="row">
          <button className="btn ghost small" onClick={() => void connect().catch(() => undefined)}>
            Test connection
          </button>
        </div>
      </section>
    </div>
  )
}
