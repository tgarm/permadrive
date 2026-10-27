// About: fee structure and comparison (read live from the chain, nothing
// hardcoded), data-sovereignty statement, feature overview. The official
// service's price is an external fact kept as a constant with its measurement
// note (≈4.41 AI3/MB as measured 2026-10; credits expire after 90 days);
// both of this project's fees are read live from the chain/contract and drift
// with the on-chain rate.

import { useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { registryParams, type RegistryParams } from '../lib/registry'
import { formatAi3 } from '../lib/bytes'

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
        <h2>Fee comparison (live)</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          PermaDrive publishes at the protocol level: what you pay is what you store, and the data is kept **permanently**. The official AutoDrive
          service prices storage in credits (expiring after 90 days, purchase requires a Google login). Both PermaDrive fees below are read live from
          the chain (consensus storage fee + FileRegistry quote); the official price is the 2026-10 measured figure.
        </p>
        {error && <div className="error-text">{error}</div>}
        {status === 'connecting' && !byteFeeShannons && <p className="muted">Connecting to the consensus chain for live rates…</p>}
        <table className="files-table">
          <thead>
            <tr>
              <th>Size</th>
              <th>Storage fee (consensus)</th>
              <th>Registry dev fee</th>
              <th>PermaDrive total</th>
              <th>Official AutoDrive</th>
              <th>Difference</th>
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
              <td>Unit price (per MB)</td>
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
              <td>credits expire in 90 days</td>
            </tr>
          </tbody>
        </table>
        <div className="kv" style={{ marginTop: 10 }}>
          <span>dev fee formula</span>
          <span className="mono small-text">max(minFee, size × feePerByte) — overpayment is refunded automatically</span>
        </div>
        <div className="kv">
          <span>Current parameters (live from the contract)</span>
          <span className="mono small-text">
            {params
              ? `feePerByte ${params.feePerByte} wei/byte · minFee ${formatAi3(params.minFee)} AI3 · cap ${formatAi3(params.maxFeePerByte)} AI3/byte (hard anti-rug ceiling)`
              : 'reading…'}
          </span>
        </div>
        <p className="privacy-note">
          The dev fee is charged on the value-added point of one-click cross-device recovery; not registering leaves the data itself untouched — files
          can always be fetched for free with their manifest or by scanning the chain directly (no involvement of this project). Registration fees go
          straight to the project treasury and fund the maintenance of the public frontend and tooling.
        </p>
      </section>

      <section className="card">
        <h2>Features and their billing</h2>
        <table className="files-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>What it does</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Permanent files</td>
              <td>Any file packed as IPLD and published on-chain, archived permanently by the farmer network; the manifest is the retrieval credential</td>
              <td>storage fee + registration (optional custody)</td>
            </tr>
            <tr>
              <td>Versioned notes</td>
              <td>Append-only text records; every save is a new immutable version, the version chain is held in the on-chain registry</td>
              <td>per version: storage fee + dev fee (small texts usually hit the 0.01 AI3 floor)</td>
            </tr>
            <tr>
              <td>Encrypted vault</td>
              <td>Entries are AES-256-GCM encrypted as one envelope before publishing (only ciphertext reaches the chain); one wallet-signature unlock, keystore file as the recovery fallback</td>
              <td>per save: storage fee + dev fee (you control the registration cadence)</td>
            </tr>
          </tbody>
        </table>
        <p className="privacy-note">
          "My files" and notes are published in the clear (permanently public); private text belongs in the encrypted vault — principles and
          do-it-yourself verification in{' '}
          <a href="./VAULT.md" target="_blank" rel="noreferrer noopener">
            VAULT.md
          </a>
          .
        </p>
      </section>

      <section className="card">
        <h2>Data sovereignty</h2>
        <div className="kv">
          <span>No accounts</span>
          <span>wallet signatures are the identity; no personal information is collected</span>
        </div>
        <div className="kv">
          <span>No backend</span>
          <span>fully static frontend; the RPC / indexer dependencies are replaceable public protocol infrastructure</span>
        </div>
        <div className="kv">
          <span>No lock-in</span>
          <span>manifests are self-contained and shareable; even if this project disappears, any public infrastructure can still retrieve your data in full</span>
        </div>
        <div className="kv">
          <span>Permanent means permanent</span>
          <span>published data cannot be deleted (that is what makes version history and undelete possible) — make sure content is fit for public before publishing</span>
        </div>
      </section>
    </div>
  )
}
