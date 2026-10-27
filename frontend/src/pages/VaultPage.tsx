// Encrypted password vault: one EVM address = one vault. Three states —
//   not initialized: create (set a passphrase → forced keystore download) or
//                     recover from the on-chain registry
//   locked: wallet-signature unlock (signature channel; non-reproducible
//           signatures fail automatically) or keystore file + passphrase (the
//           only universal recovery path)
//   unlocked: entry CRUD (in-memory only) + save on-chain (reseal → new CID →
//             publish → manifest re-publish → registry register, manual and
//             billed normally)
// The envelope format and key architecture live in lib/vaultCrypto.ts / lib/vault.ts.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { formatBytes } from '../lib/bytes'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload } from '../lib/publish'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { retrieveFile } from '../lib/retrieve'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { getVault, putManifest, putVault, type VaultRecord, type VaultVersionRecord } from '../lib/store'
import { openPayload, unwrapWithPassphrase, type KeystoreFileV1 } from '../lib/vaultCrypto'
import {
  createVaultEnvelope,
  newVaultEntryId,
  parseEnvelope,
  parseKeystoreFile,
  parseVaultEntries,
  parseVaultFileName,
  resealVaultEnvelope,
  signEvmMessage,
  unlockVaultWithSignature,
  vaultFileName,
  vaultSignMessage,
  type VaultEntry,
} from '../lib/vault'
import { nodeCount, useI18n } from '../i18n'

const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => PW_ALPHABET[b % PW_ALPHABET.length]).join('')
}

function saveBlob(bytes: Uint8Array, name: string, mimeType: string | null): void {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const blob = new Blob([copy], { type: mimeType ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

interface SaveSession {
  stage: 'packing' | 'awaiting-confirm' | 'publishing' | 'error'
  detail?: string
  error?: string
  prepared?: PreparedUpload
  fee?: { shannons: bigint; ai3: number }
  devFee?: { wei: bigint; ai3: string }
  envelope?: Awaited<ReturnType<typeof resealVaultEnvelope>>
}

interface EntryDraft {
  id: string | null
  title: string
  username: string
  password: string
  url: string
  notes: string
}

const EMPTY_DRAFT: EntryDraft = { id: null, title: '', username: '', password: '', url: '', notes: '' }

export function VaultPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active, evm } = useSigner()
  const [record, setRecord] = useState<VaultRecord | null>(null)
  // Session key and decrypted entries: memory only, lost on refresh (unlock again)
  const [vaultKey, setVaultKey] = useState<Uint8Array | null>(null)
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  const [lastSealed, setLastSealed] = useState<string | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [keystorePending, setKeystorePending] = useState<KeystoreFileV1 | null>(null)
  const [keystoreSaved, setKeystoreSaved] = useState(false)

  const [keystoreFile, setKeystoreFile] = useState<KeystoreFileV1 | null>(null)
  const [unlockPass, setUnlockPass] = useState('')

  const [draft, setDraft] = useState<EntryDraft | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  const [session, setSession] = useState<SaveSession | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [unlockError, setUnlockError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!evm) {
      setRecord(null)
      return
    }
    setRecord((await getVault(evm.address)) ?? null)
  }, [evm])

  useEffect(() => {
    // Switching signers locks immediately (the session key is bound to the address)
    setVaultKey(null)
    setEntries(null)
    setLastSealed(null)
    setKeystoreFile(null)
    setUnlockPass('')
    setKeystorePending(null)
    setSession(null)
    setDraft(null)
    void refresh()
  }, [refresh])

  const unlocked = vaultKey != null && entries != null

  const copy = (text: string, tag: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(tag)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const openWithKey = async (key: Uint8Array, envelope: VaultRecord['envelope']) => {
    const plain = await openPayload(key, envelope.cipher)
    const list = parseVaultEntries(plain)
    setVaultKey(key)
    setEntries(list)
    setLastSealed(JSON.stringify(list))
    setUnlockError(null)
    setUnlockPass('')
    setKeystoreFile(null)
  }

  // ---- create ----

  const createVault = async () => {
    setNotice(null)
    if (!evm) return
    if (passphrase.length < 8) {
      setNotice(t('vault.passShort'))
      return
    }
    if (passphrase !== passphrase2) {
      setNotice(t('vault.passMismatch'))
      return
    }
    setBusy(t('vault.generating'))
    try {
      // The signature wrap is best-effort: refusing to sign in the injected
      // wallet still allows creation (the passphrase channel remains)
      let signature: Uint8Array | null = null
      try {
        setBusy(t('vault.signingBind'))
        signature = await signEvmMessage(evm, vaultSignMessage(evm.address))
      } catch {
        signature = null
      }
      const created = await createVaultEnvelope(evm.address, passphrase, signature)
      await putVault({ address: evm.address, envelope: created.envelope, versions: [], createdAt: Date.now() })
      setKeystorePending(created.keystore)
      setKeystoreSaved(false)
      setVaultKey(created.vaultKey)
      setEntries(created.entries)
      setLastSealed(JSON.stringify(created.entries))
      setPassphrase('')
      setPassphrase2('')
      await refresh()
      setNotice(t('vault.createdLocal'))
    } catch (e) {
      setNotice(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const finishKeystore = () => {
    if (!keystoreSaved) return
    setKeystorePending(null)
  }

  // ---- unlock ----

  const unlockWithWallet = async () => {
    if (!evm || !record) return
    setUnlockError(null)
    setBusy(t('stage.signing'))
    try {
      const key = await unlockVaultWithSignature(record.envelope, evm)
      if (!key) {
        setUnlockError(t('vault.noSignatureChannel'))
        return
      }
      await openWithKey(key, record.envelope)
    } catch (e) {
      setUnlockError(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const unlockWithKeystore = async () => {
    if (!record) return
    setUnlockError(null)
    if (!keystoreFile) {
      setUnlockError(t('vault.pickKeystoreFirst'))
      return
    }
    if (keystoreFile.address !== record.address) {
      setUnlockError(t('vault.keystoreMismatch', [keystoreFile.address.slice(0, 10), record.address.slice(0, 10)]))
      return
    }
    setBusy(t('vault.decrypting'))
    try {
      const key = await unwrapWithPassphrase(keystoreFile.wrapped, unlockPass)
      await openWithKey(key, record.envelope)
    } catch {
      setUnlockError(t('vault.wrongPassphrase'))
    } finally {
      setBusy(null)
    }
  }

  const lock = () => {
    setVaultKey(null)
    setEntries(null)
    setLastSealed(null)
    setDraft(null)
    setRevealed(new Set())
  }

  // ---- entry CRUD (in-memory) ----

  const saveDraft = () => {
    if (!entries || !draft) return
    if (!draft.title.trim()) {
      setNotice(t('vault.needEntryTitle'))
      return
    }
    const now = Date.now()
    if (draft.id) {
      setEntries(entries.map((e) => (e.id === draft.id ? { ...draft, id: draft.id, createdAt: e.createdAt, updatedAt: now } : e)))
    } else {
      setEntries([...entries, { ...draft, id: newVaultEntryId(), createdAt: now, updatedAt: now }])
    }
    setDraft(null)
    setNotice(null)
  }

  const removeEntry = (id: string) => {
    if (!entries) return
    if (!window.confirm(t('vault.deleteEntryConfirm'))) return
    setEntries(entries.filter((e) => e.id !== id))
  }

  // ---- save on-chain ----

  const requestSave = async () => {
    setNotice(null)
    if (!entries || !vaultKey || !record) return
    if (JSON.stringify(entries) === lastSealed) {
      setNotice(t('vault.unchangedSinceSeal'))
      return
    }
    if (!active || !evm) {
      setNotice(t('common.needSigners'))
      return
    }
    setSession({ stage: 'packing' })
    try {
      const envelope = await resealVaultEnvelope(record.envelope, entries, vaultKey)
      const file = new File([JSON.stringify(envelope)], vaultFileName(record.address), { type: 'application/json' })
      const prepared = await prepareUpload(file)
      const api = await connect()
      const fee = await estimateFee(api, prepared.totalBytes)
      const devWei = await quoteRegisterFee(prepared.file.size)
      setSession({
        stage: 'awaiting-confirm',
        prepared,
        fee,
        devFee: { wei: devWei, ai3: (Number(devWei) / 1e18).toFixed(4) },
        envelope,
      })
    } catch (e) {
      setSession((s) => (s ? { ...s, stage: 'error', error: (e as Error).message } : s))
    }
  }

  const confirmSave = async () => {
    const s = session
    if (!s?.prepared || !s.fee || !s.devFee || !s.envelope || s.stage !== 'awaiting-confirm') return
    if (!active || !evm || !record || entries == null) return
    try {
      const api = await connect()
      const manifest = await publishPrepared(api, s.prepared, active, (stage, detail) => {
        const text = {
          signing: t('stage.signing'),
          submitting: t('stage.submitting'),
          scanning: t('stage.scanning'),
          confirming: t('stage.confirming'),
        }[stage] ?? stage
        setSession((cur) => (cur ? { ...cur, stage: 'publishing', detail: detail ? `${text} ${detail}` : text } : cur))
      })
      await putManifest(manifest)
      setSession((cur) => (cur ? { ...cur, detail: t('stage.manifestPublishing') } : cur))
      const publication = await publishManifestToChain(api, manifest, active, (_stage, detail) =>
        setSession((cur) => (cur ? { ...cur, stage: 'publishing', detail } : cur)),
      )
      setSession((cur) => (cur ? { ...cur, detail: t('files.registering', [s.devFee!.ai3]) } : cur))
      await registerFile(
        evm,
        { manifestCid: publication.manifestCid, height: publication.height, name: manifest.file.name, size: s.prepared.file.size },
        { fee: s.devFee.wei },
      )
      const version: VaultVersionRecord = {
        rootCid: manifest.rootCid,
        manifestCid: publication.manifestCid,
        height: publication.height,
        name: manifest.file.name,
        size: s.prepared.file.size,
        savedAt: Date.now(),
      }
      const updated: VaultRecord = {
        address: record.address,
        envelope: s.envelope,
        versions: [...record.versions, version],
        createdAt: record.createdAt,
      }
      await putVault(updated)
      setLastSealed(JSON.stringify(entries))
      setSession(null)
      setNotice(t('vault.publishedEnvelope', [updated.versions.length, manifest.txs[0].height, s.devFee.ai3]))
      await refresh()
    } catch (e) {
      setSession((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
    }
  }

  // ---- recover from the on-chain registry (fetch the latest envelope; older versions land in the table) ----

  const recoverFromRegistry = async () => {
    setNotice(null)
    if (!evm) return
    setBusy(t('vault.readingRegistry'))
    try {
      const registryEntries = await fetchEntries(evm.address)
      // Ascending (growing height = version order), matching the publish-side
      // versions[] convention (the UI lists the newest first)
      const vaultEntries = registryEntries
        .filter((e) => parseVaultFileName(e.name) !== null)
        .sort((a, b) => a.height - b.height)
      if (vaultEntries.length === 0) {
        setNotice(t('vault.noVaultEntries', [registryEntries.length]))
        return
      }
      const api = await connect()
      const latest = vaultEntries[vaultEntries.length - 1]
      setBusy(t('vault.fetchingEnvelope', [latest.height]))
      const manifest = await recoverManifestFromHint(api, latest.manifestCid, latest.height)
      await putManifest(manifest)
      const result = await retrieveFile(api, manifest)
      const envelope = parseEnvelope(JSON.parse(new TextDecoder().decode(result.bytes)))
      if (envelope.address !== evm.address.toLowerCase()) throw new Error(t('errors.envelopeOwnerMismatch'))
      const versions: VaultVersionRecord[] = vaultEntries.map((e) => ({
        rootCid: e.manifestCid === latest.manifestCid ? manifest.rootCid : '',
        manifestCid: e.manifestCid,
        height: e.height,
        name: e.name,
        size: Number(e.size),
        savedAt: Number(e.registeredAt) * 1000,
      }))
      await putVault({ address: evm.address, envelope, versions, createdAt: envelope.createdAt })
      await refresh()
      lock()
      setNotice(t('vault.recovered', [t(versions.length === 1 ? 'common.oneOnChainVersion' : 'common.nOnChainVersions', [versions.length])]))
    } catch (e) {
      setNotice(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- render ----

  if (!evm) {
    return (
      <div className="page">
        <section className="card">
          <h2>{t('vault.title')}</h2>
          <p className="muted">{t('vault.needEvm')}</p>
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      {notice && (
        <div className="card">
          <div className="notice" style={{ marginBottom: 0 }}>
            {notice}
          </div>
        </div>
      )}

      {/* create (no local record yet) */}
      {!record && !keystorePending && (
        <section className="card">
          <h2>{t('vault.createTitle', [evm.address.slice(0, 10)])}</h2>
          <p className="muted">
            {t('vault.createIntro')}
            <Hint>
              {t('vault.createHint')}{' '}
              <a href="https://github.com/tgarm/permadrive/blob/main/VAULT.md" target="_blank" rel="noreferrer noopener">
                VAULT.md
              </a>
              .
            </Hint>
          </p>
          <label className="field">
            <span>{t('vault.passphraseLabel')}</span>
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('vault.passphraseRepeat')}</span>
            <input type="password" value={passphrase2} onChange={(e) => setPassphrase2(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn primary" onClick={() => void createVault()} disabled={!!busy}>
              {t('vault.createBtn')}
            </button>
            <button className="btn ghost" onClick={() => void recoverFromRegistry()} disabled={!!busy}>
              {t('vault.recoverBtn')}
            </button>
            {busy && <span className="stage-line" style={{ marginTop: 0 }}>{busy}</span>}
          </div>
        </section>
      )}

      {/* forced keystore export */}
      {keystorePending && (
        <section className="card">
          <h2>{t('vault.keystoreTitle')}</h2>
          <p className="warning">{t('vault.keystoreWarning')}</p>
          <div className="row">
            <button
              className="btn primary"
              onClick={() =>
                saveBlob(new TextEncoder().encode(JSON.stringify(keystorePending, null, 2)), `permadrive-keystore-${evm.address.slice(2, 10)}.json`, 'application/json')
              }
            >
              {t('vault.downloadKeystore')}
            </button>
            <label className="row" style={{ marginTop: 0 }}>
              <input type="checkbox" checked={keystoreSaved} onChange={(e) => setKeystoreSaved(e.target.checked)} />
              <span className="small-text">{t('vault.keystoreSaved')}</span>
            </label>
            <button className="btn" onClick={finishKeystore} disabled={!keystoreSaved}>
              {t('vault.done')}
            </button>
          </div>
        </section>
      )}

      {/* locked */}
      {record && !unlocked && !keystorePending && (
        <section className="card">
          <h2>
            {t('vault.lockedTitle', [
              record.address.slice(0, 10),
              t(record.versions.length === 1 ? 'common.oneOnChainVersion' : 'common.nOnChainVersions', [record.versions.length]),
            ])}
          </h2>
          <p className="muted small-text" style={{ marginTop: 0 }}>
            {t('vault.lockedIntro')}
          </p>
          <div className="row">
            <button className="btn primary" onClick={() => void unlockWithWallet()} disabled={!!busy}>
              {t('vault.unlockWallet')}
            </button>
            <button className="btn ghost" onClick={() => void recoverFromRegistry()} disabled={!!busy}>
              {t('vault.recoverBtn')}
            </button>
            {busy && <span className="stage-line" style={{ marginTop: 0 }}>{busy}</span>}
          </div>
          <div className="divider" />
          <p className="muted small-text">{t('vault.keystoreFallbackIntro')}</p>
          <div className="row" style={{ marginTop: 4 }}>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                void f
                  .text()
                  .then((txt) => setKeystoreFile(parseKeystoreFile(JSON.parse(txt))))
                  .catch(() => setUnlockError(t('vault.keystoreParseFailed')))
              }}
            />
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <input
              type="password"
              value={unlockPass}
              onChange={(e) => setUnlockPass(e.target.value)}
              placeholder={t('vault.keystorePassphrase')}
              style={{ width: 220 }}
            />
            <button className="btn" onClick={() => void unlockWithKeystore()} disabled={!!busy || !keystoreFile}>
              {t('vault.unlockKeystore')}
            </button>
            {keystoreFile && <span className="ok small-text">✓ {keystoreFile.address.slice(0, 10)}…</span>}
          </div>
          {unlockError && <div className="error-text" style={{ marginTop: 8 }}>{unlockError}</div>}
        </section>
      )}

      {/* unlocked */}
      {record && unlocked && entries && (
        <section className="card">
          <div className="card-head">
            <h2>{t('vault.entriesTitle', [entries.length])}</h2>
            <div className="row-actions">
              <button className="btn ghost small" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                {t('vault.addEntry')}
              </button>
              <button className="btn primary small" onClick={() => void requestSave()}>
                {t('vault.saveOnChain')}
              </button>
              <button className="btn ghost small" onClick={lock}>
                {t('vault.lock')}
              </button>
            </div>
          </div>
          <p className="privacy-note" style={{ margin: '0 0 10px' }}>
            {t('vault.privacyMemory')}
            <Hint>{t('vault.hintEncryption')}</Hint>
          </p>

          {draft && (
            <div className="entry-form">
              <label className="field">
                <span>{t('vault.fieldTitle')}</span>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <div className="entry-form-grid">
                <label className="field">
                  <span>{t('vault.fieldUsername')}</span>
                  <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t('vault.fieldPassword')}</span>
                  <div className="row" style={{ marginTop: 0 }}>
                    <input value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} spellCheck={false} />
                    <button className="btn ghost small" onClick={() => setDraft({ ...draft, password: generatePassword() })}>
                      {t('vault.generate')}
                    </button>
                  </div>
                </label>
              </div>
              <label className="field">
                <span>{t('vault.fieldUrl')}</span>
                <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} spellCheck={false} />
              </label>
              <label className="field">
                <span>{t('vault.fieldNotes')}</span>
                <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3} />
              </label>
              <div className="row" style={{ marginTop: 0 }}>
                <button className="btn primary small" onClick={saveDraft}>
                  {draft.id ? t('vault.updateEntryMem') : t('vault.addEntryMem')}
                </button>
                <button className="btn ghost small" onClick={() => setDraft(null)}>
                  {t('common.cancel')}
                </button>
              </div>
              <div className="divider" />
            </div>
          )}

          {entries.length === 0 ? (
            <p className="muted">{t('vault.emptyEntries')}</p>
          ) : (
            <table className="files-table">
              <thead>
                <tr>
                  <th>{t('vault.thTitle')}</th>
                  <th>{t('vault.thUsername')}</th>
                  <th>{t('vault.thPassword')}</th>
                  <th>{t('vault.thUpdated')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="file-name">{entry.title}</div>
                      {entry.url && (
                        <a className="small-text" href={entry.url} target="_blank" rel="noreferrer">
                          {entry.url.slice(0, 40)}…
                        </a>
                      )}
                      {entry.notes && <div className="small-text muted">{entry.notes}</div>}
                    </td>
                    <td>
                      <div className="pw-cell">
                        <span className="mono small-text">{entry.username || '—'}</span>
                        {entry.username && (
                          <button className="btn link" onClick={() => copy(entry.username, `${entry.id}:u`)}>
                            {copied === `${entry.id}:u` ? '✓' : t('common.copy')}
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="pw-cell">
                        <span className="mono small-text">{revealed.has(entry.id) ? entry.password : '••••••••'}</span>
                        <button className="btn link" onClick={() => setRevealed(new Set([...revealed, entry.id]))}>
                          {revealed.has(entry.id) ? '' : t('vault.show')}
                        </button>
                        {revealed.has(entry.id) && (
                          <>
                            <button className="btn link" onClick={() => copy(entry.password, `${entry.id}:p`)}>
                              {copied === `${entry.id}:p` ? '✓' : t('common.copy')}
                            </button>
                            <button className="btn link" onClick={() => setRevealed(new Set([...revealed].filter((x) => x !== entry.id)))}>
                              {t('vault.hide')}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="small-text">{new Date(entry.updatedAt).toLocaleString()}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="btn ghost small"
                          onClick={() =>
                            setDraft({
                              id: entry.id,
                              title: entry.title,
                              username: entry.username,
                              password: entry.password,
                              url: entry.url,
                              notes: entry.notes,
                            })
                          }
                        >
                          {t('common.edit')}
                        </button>
                        <button className="btn ghost small danger" onClick={() => removeEntry(entry.id)}>
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {session && (
            <div className="upload-session">
              {session.stage === 'awaiting-confirm' && session.prepared && session.fee && session.devFee ? (
                <div className="confirm-panel">
                  <div className="kv">
                    <span>{t('vault.envelopeVersion')}</span>
                    <span>
                      v{record.versions.length + 1} · {nodeCount(session.prepared.nodes.length)} · {formatBytes(session.prepared.totalBytes)}
                    </span>
                  </div>
                  <div className="kv fee">
                    <span>{t('common.storageFeeEstimate')}</span>
                    <span>≈ {session.fee.ai3.toFixed(4)} AI3</span>
                  </div>
                  <div className="kv fee">
                    <span>{t('common.registryDevFee')}</span>
                    <span>{session.devFee.ai3} AI3</span>
                  </div>
                  <p className="warning">{t('vault.warningCiphertext')}</p>
                  <div className="row">
                    <button className="btn primary" onClick={() => void confirmSave()}>
                      {t('common.signAndPublish')}
                    </button>
                    <button className="btn ghost" onClick={() => setSession(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : session.stage === 'error' ? (
                <div>
                  <div className="error-text">{session.error}</div>
                  <button className="btn ghost small" onClick={() => setSession(null)}>
                    {t('common.close')}
                  </button>
                </div>
              ) : (
                <div className="stage-line">
                  {t('stage.publishing')}
                  {session.detail ? <span className="muted"> · {session.detail}</span> : null}
                </div>
              )}
            </div>
          )}

          {record.versions.length > 0 && (
            <>
              <h2 style={{ marginTop: 18, fontSize: 14 }}>{t('vault.onChainVersions', [record.versions.length])}</h2>
              <table className="files-table">
                <thead>
                  <tr>
                    <th>{t('vault.thVersion')}</th>
                    <th>{t('common.size')}</th>
                    <th>{t('vault.thPublished')}</th>
                    <th>manifest CID</th>
                  </tr>
                </thead>
                <tbody>
                  {[...record.versions].reverse().map((v, i) => (
                    <tr key={`${v.manifestCid}-${v.height}`}>
                      <td>v{record.versions.length - i}</td>
                      <td>{formatBytes(v.size)}</td>
                      <td className="small-text">{new Date(v.savedAt).toLocaleString()}</td>
                      <td className="mono small-text muted">{v.manifestCid.slice(0, 24)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  )
}
