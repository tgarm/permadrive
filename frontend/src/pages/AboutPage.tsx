// About: fee composition and comparison (read live from the chain, never
// hardcoded), the data-sovereignty statement, and a feature overview. The
// official price is an external fact kept as a constant with a measurement
// note (≈4.41 AI3/MB as measured 2026-10; credits expire after 90 days);
// both of this project's fees are read live from the chain/contract and drift
// with the on-chain rate.

import { useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { registryParams, type RegistryParams } from '../lib/registry'
import { formatAi3 } from '../lib/bytes'
import { useI18n } from '../i18n'

// Official AutoDrive mainnet price (measured 2026-10, including its
// CREDITS_PRICE_MULTIPLIER=2.0); credits expire after 90 days and purchasing
// requires a Google login. Comparison baseline only — not this app's pricing.
const OFFICIAL_AI3_PER_MB = 4.41
const MB = 1_048_576

const SIZES = [100 * 1024, MB] as const

function ai3(n: number): string {
  return n.toFixed(4)
}

export function AboutPage() {
  const { t } = useI18n()
  const { byteFeeShannons, connect, status } = useChain()
  const [params, setParams] = useState<RegistryParams | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void connect().catch(() => undefined)
    registryParams()
      .then(setParams)
      .catch((e) => setError((e as Error).message))
  }, [connect])

  // Pricing formula (identical to the contract's quote): dev fee = max(minFee, size × feePerByte)
  const devFeeAi3 = (size: number): number | null => {
    if (!params) return null
    const bySize = params.feePerByte * BigInt(size)
    return Number(bySize > params.minFee ? bySize : params.minFee) / 1e18
  }
  const storageAi3 = (size: number): number | null =>
    byteFeeShannons != null ? Number(byteFeeShannons * BigInt(size)) / 1e18 : null

  const rows = SIZES.map((size) => {
    const storage = storageAi3(size)
    const dev = devFeeAi3(size)
    const total = storage != null && dev != null ? storage + dev : null
    const official = (OFFICIAL_AI3_PER_MB * size) / MB
    return { label: size >= MB ? `${size / MB} MB` : `${size / 1024} KB`, size, storage, dev, total, official }
  })
  const paramsPerMb = params ? Number(params.feePerByte * BigInt(MB)) / 1e18 : null

  return (
    <div className="page">
      <section className="card">
        <h2>{t('about.feeTitle')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('about.feeIntro')}
        </p>
        {error && <div className="error-text">{error}</div>}
        {status === 'connecting' && !byteFeeShannons && <p className="muted">{t('about.connectingRates')}</p>}
        <table className="files-table">
          <thead>
            <tr>
              <th>{t('about.thSize')}</th>
              <th>{t('about.thStorageFee')}</th>
              <th>{t('about.thRegistryFee')}</th>
              <th>{t('about.thTotal')}</th>
              <th>{t('about.thOfficial')}</th>
              <th>{t('about.thDifference')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.storage != null ? `≈ ${ai3(r.storage)} AI3` : '—'}</td>
                <td>{r.dev != null ? `${ai3(r.dev)} AI3` : '—'}</td>
                <td>
                  <strong>{r.total != null ? `≈ ${ai3(r.total)} AI3` : '—'}</strong>
                </td>
                <td>≈ {ai3(r.official)} AI3</td>
                <td className="ok">{r.total != null ? `-${Math.round((1 - r.total / r.official) * 100)}%` : '—'}</td>
              </tr>
            ))}
            <tr>
              <td>{t('about.unitPrice')}</td>
              <td>{byteFeeShannons != null ? `≈ ${ai3(Number(byteFeeShannons * BigInt(MB)) / 1e18)} AI3` : '—'}</td>
              <td>{paramsPerMb != null ? `${ai3(paramsPerMb)} AI3` : '—'}</td>
              <td>
                <strong>
                  {byteFeeShannons != null && paramsPerMb != null
                    ? `≈ ${ai3(Number(byteFeeShannons * BigInt(MB)) / 1e18 + paramsPerMb)} AI3`
                    : '—'}
                </strong>
              </td>
              <td>≈ {ai3(OFFICIAL_AI3_PER_MB)} AI3</td>
              <td>{t('about.creditsExpire')}</td>
            </tr>
          </tbody>
        </table>
        <div className="kv" style={{ marginTop: 10 }}>
          <span>{t('about.feeFormulaLabel')}</span>
          <span className="mono small-text">{t('about.feeFormula')}</span>
        </div>
        <div className="kv">
          <span>{t('about.paramsLabel')}</span>
          <span className="mono small-text">
            {params
              ? t('about.paramsValue', [params.feePerByte, formatAi3(params.minFee), formatAi3(params.maxFeePerByte)])
              : t('about.reading')}
          </span>
        </div>
        <p className="privacy-note">{t('about.sovereigntyNote')}</p>
      </section>

      <section className="card">
        <h2>{t('about.featuresTitle')}</h2>
        <table className="files-table">
          <thead>
            <tr>
              <th>{t('about.thFeature')}</th>
              <th>{t('about.thWhatItDoes')}</th>
              <th>{t('about.thCost')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('about.featureFiles')}</td>
              <td>{t('about.featureFilesDesc')}</td>
              <td>{t('about.featureFilesCost')}</td>
            </tr>
            <tr>
              <td>{t('about.featureNotes')}</td>
              <td>{t('about.featureNotesDesc')}</td>
              <td>{t('about.featureNotesCost')}</td>
            </tr>
            <tr>
              <td>{t('about.featureVault')}</td>
              <td>{t('about.featureVaultDesc')}</td>
              <td>{t('about.featureVaultCost')}</td>
            </tr>
          </tbody>
        </table>
        <p className="privacy-note">
          {t('about.plaintextNote')}{' '}
          <a href="https://github.com/tgarm/permadrive/blob/main/VAULT.md" target="_blank" rel="noreferrer noopener">
            VAULT.md
          </a>
          .
        </p>
      </section>

      <section className="card">
        <h2>{t('about.sovereigntyTitle')}</h2>
        <div className="kv">
          <span>{t('about.sovAccounts')}</span>
          <span>{t('about.sovAccountsDesc')}</span>
        </div>
        <div className="kv">
          <span>{t('about.sovBackend')}</span>
          <span>{t('about.sovBackendDesc')}</span>
        </div>
        <div className="kv">
          <span>{t('about.sovLockIn')}</span>
          <span>{t('about.sovLockInDesc')}</span>
        </div>
        <div className="kv">
          <span>{t('about.sovPermanent')}</span>
          <span>{t('about.sovPermanentDesc')}</span>
        </div>
      </section>
    </div>
  )
}
