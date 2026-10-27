// Versioned text: note list on the left, editor on the right. Save = pack and
// publish the content → re-publish the manifest → register in the registry
// (every version bills normally; fee quote panel first). Version history is
// recovered from registry entries (pdnote- naming convention grouping); the
// local IndexedDB is only a cache. Content goes on-chain in plaintext (same
// model as "My files") — private text belongs in the encrypted vault.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { formatBytes } from '../lib/bytes'
import { newNoteId, noteFileName, parseNoteFileName, groupNoteEntries, titleFromSlug } from '../lib/notes'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload } from '../lib/publish'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { retrieveFile } from '../lib/retrieve'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { deleteNote, getManifest, listNotes, putManifest, putNote, type NoteRecord, type NoteVersionRecord } from '../lib/store'
import { nodeCount, useI18n, versionCount } from '../i18n'

interface SaveSession {
  noteId: string
  version: number
  name: string
  stage: 'packing' | 'awaiting-confirm' | 'publishing' | 'error'
  detail?: string
  error?: string
  prepared?: PreparedUpload
  fee?: { shannons: bigint; ai3: number }
  devFee?: { wei: bigint; ai3: string }
}

export function NotesPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active, evm } = useSigner()
  const [notes, setNotes] = useState<NoteRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [session, setSession] = useState<SaveSession | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(false)

  const refresh = useCallback(async () => {
    const ns = await listNotes()
    ns.sort((a, b) => b.updatedAt - a.updatedAt)
    setNotes(ns)
    return ns
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Open a note: when there is no local draft (record recovered on a new device),
  // fetch the latest version's content automatically
  const openNote = async (note: NoteRecord) => {
    setActiveId(note.id)
    setNotice(null)
    setSession(null)
    setTitle(note.title)
    if (note.content === '' && note.versions.length > 0) {
      const latest = note.versions[note.versions.length - 1]
      setRowBusy(t('notes.fetchLatest', [latest.version]))
      try {
        const text = await fetchVersionText(latest)
        setContent(text)
        await putNote({ ...note, content: text })
        setRowBusy(null)
      } catch (e) {
        setRowBusy(t('notes.fetchFailed', [(e as Error).message]))
      }
    } else {
      setContent(note.content)
    }
  }

  const fetchVersionText = async (version: NoteVersionRecord): Promise<string> => {
    const api = await connect()
    let manifest = await getManifest(version.rootCid)
    if (!manifest) manifest = await recoverManifestFromHint(api, version.manifestCid, version.height)
    const result = await retrieveFile(api, manifest)
    if (!result.sha256Match) throw new Error(t('errors.sha256Mismatch', [result.sha256.slice(0, 16)]))
    return new TextDecoder().decode(result.bytes)
  }

  const createNote = () => {
    const note: NoteRecord = {
      id: newNoteId(),
      title: '',
      content: '',
      versions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setNotice(null)
    setSession(null)
    void putNote(note).then(refresh)
    setActiveId(note.id)
    setTitle('')
    setContent('')
  }

  // Save the local draft only (nothing published) — a safety net before
  // switching notes / refreshing
  const saveDraftLocal = async () => {
    if (!activeId) return
    const note = notes.find((n) => n.id === activeId)
    if (!note) return
    await putNote({ ...note, title, content, updatedAt: Date.now() })
    await refresh()
  }

  // ---- Save on-chain (new version = publish content + publish manifest + registry register) ----

  const requestSave = async () => {
    setNotice(null)
    if (!activeId || !content.trim()) {
      setNotice(t('notes.contentEmpty'))
      return
    }
    if (!active || !evm) {
      setNotice(t('common.needSigners'))
      return
    }
    const note = notes.find((n) => n.id === activeId)
    if (!note) return
    const version = note.versions.length + 1
    // No version number in the filename (it feeds content addressing): saving
    // identical content under the same title is idempotent and free
    const name = noteFileName(note.id, title || t('common.untitled'))
    setSession({ noteId: note.id, version, name, stage: 'packing' })
    try {
      const file = new File([content], name, { type: 'text/markdown' })
      const prepared = await prepareUpload(file)
      const last = note.versions[note.versions.length - 1]
      if (last && last.rootCid === prepared.rootCid) {
        setSession(null)
        setNotice(t('notes.unchanged'))
        return
      }
      const api = await connect()
      const fee = await estimateFee(api, prepared.totalBytes)
      const devWei = await quoteRegisterFee(prepared.file.size)
      setSession((s) =>
        s ? { ...s, prepared, fee, devFee: { wei: devWei, ai3: (Number(devWei) / 1e18).toFixed(4) }, stage: 'awaiting-confirm' } : s,
      )
    } catch (e) {
      setSession((s) => (s ? { ...s, stage: 'error', error: (e as Error).message } : s))
    }
  }

  const confirmSave = async () => {
    const s = session
    if (!s?.prepared || !s.fee || !s.devFee || s.stage !== 'awaiting-confirm') return
    if (!active || !evm) return
    const note = notes.find((n) => n.id === s.noteId)
    if (!note) return
    try {
      const api = await connect()
      // 1) content file into the DSN
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
      // 2) manifest re-published into the DSN (registry entry locator, same path as "My files" sync)
      const publication = await publishManifestToChain(api, manifest, active, (_stage, detail) =>
        setSession((cur) => (cur ? { ...cur, stage: 'publishing', detail } : cur)),
      )
      // 3) registry register (dev fee)
      setSession((cur) => (cur ? { ...cur, detail: t('files.registering', [s.devFee!.ai3]) } : cur))
      await registerFile(
        evm,
        { manifestCid: publication.manifestCid, height: publication.height, name: s.name, size: s.prepared.file.size },
        { fee: s.devFee.wei },
      )
      const versionRecord: NoteVersionRecord = {
        rootCid: manifest.rootCid,
        manifestCid: publication.manifestCid,
        height: publication.height,
        name: s.name,
        version: s.version,
        size: s.prepared.file.size,
        savedAt: Date.now(),
      }
      await putNote({
        ...note,
        title,
        content,
        versions: [...note.versions, versionRecord],
        updatedAt: Date.now(),
      })
      setSession(null)
      setNotice(t('notes.publishedVersion', [s.version, manifest.txs[0].height, s.devFee.ai3, publication.txHash.slice(0, 14) + '…']))
      await refresh()
    } catch (e) {
      setSession((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
    }
  }

  // ---- version actions ----

  const downloadVersion = async (version: NoteVersionRecord) => {
    setNotice(null)
    setRowBusy(t('files.retrieving'))
    try {
      const api = await connect()
      let manifest = await getManifest(version.rootCid)
      if (!manifest) manifest = await recoverManifestFromHint(api, version.manifestCid, version.height)
      const result = await retrieveFile(api, manifest)
      saveBlob(result.bytes, version.name, 'text/markdown')
      setRowBusy(result.sha256Match ? t('notes.sha256MatchV', [version.version]) : t('notes.sha256MismatchV', [version.version]))
    } catch (e) {
      setRowBusy(`✗ ${(e as Error).message}`)
    }
  }

  const restoreVersion = async (version: NoteVersionRecord) => {
    setNotice(null)
    setRowBusy(t('notes.fetchingV', [version.version]))
    try {
      const text = await fetchVersionText(version)
      setContent(text)
      setTitle(titleFromSlug(parseNoteFileName(version.name)?.titleSlug ?? ''))
      setRowBusy(t('notes.loadedEditor', [version.version]))
    } catch (e) {
      setRowBusy(`✗ ${(e as Error).message}`)
    }
  }

  // ---- recover from the on-chain registry (the version chain's authority) ----

  const recoverNotes = async () => {
    setNotice(null)
    if (!evm) {
      setNotice(t('notes.recoverNeedEvm'))
      return
    }
    setRecovering(true)
    try {
      setNotice(t('notes.readingRegistry'))
      const entries = await fetchEntries(evm.address)
      const groups = groupNoteEntries(entries)
      if (groups.size === 0) {
        setNotice(t('notes.noNoteEntries', [entries.length]))
        return
      }
      const api = await connect()
      let newNotes = 0
      let newVersions = 0
      let idx = 0
      for (const [id, groupEntries] of groups) {
        idx++
        setNotice(t('notes.recoveringNote', [idx, groups.size, versionCount(groupEntries.length)]))
        const versions: NoteVersionRecord[] = []
        for (const entry of groupEntries) {
          const ref = parseNoteFileName(entry.name)
          if (!ref) continue
          const manifest = await recoverManifestFromHint(api, entry.manifestCid, entry.height)
          await putManifest(manifest)
          versions.push({
            rootCid: manifest.rootCid,
            manifestCid: entry.manifestCid,
            height: entry.height,
            name: manifest.file.name,
            version: 0, // numbered after sorting by height
            size: Number(entry.size),
            savedAt: Number(entry.registeredAt) * 1000,
          })
        }
        versions.sort((a, b) => a.height - b.height)
        versions.forEach((v, i) => (v.version = i + 1))
        const existing = (await listNotes()).find((n) => n.id === id)
        if (existing) {
          const known = new Set(existing.versions.map((v) => v.rootCid))
          const merged = [...existing.versions, ...versions.filter((v) => !known.has(v.rootCid))]
          merged.sort((a, b) => a.height - b.height)
          await putNote({ ...existing, versions: merged, updatedAt: Date.now() })
          newVersions += merged.length - existing.versions.length
        } else {
          const latest = versions[versions.length - 1]
          await putNote({
            id,
            title: titleFromSlug(parseNoteFileName(latest.name)?.titleSlug ?? ''),
            content: '', // fetched automatically when the note is opened
            versions,
            createdAt: versions[0].savedAt,
            updatedAt: latest.savedAt,
          })
          newNotes++
        }
      }
      await refresh()
      setNotice(
        t('notes.recoverDone', [
          t(newNotes === 1 ? 'notes.oneNewNote' : 'notes.nNewNotes', [newNotes]),
          newVersions > 0 ? t('notes.newVersionsSuffix', [newVersions]) : '',
          groups.size,
        ]),
      )
    } catch (e) {
      setNotice(`✗ ${(e as Error).message}`)
    } finally {
      setRecovering(false)
    }
  }

  const removeNote = async (note: NoteRecord) => {
    if (!window.confirm(t('notes.deleteConfirm', [note.title || t('common.untitled')]))) return
    await deleteNote(note.id)
    if (activeId === note.id) {
      setActiveId(null)
      setTitle('')
      setContent('')
    }
    await refresh()
  }

  const activeNote = notes.find((n) => n.id === activeId) ?? null

  return (
    <div className="page">
      {notice && (
        <div className="card">
          <div className="notice" style={{ marginBottom: 0 }}>
            {notice}
          </div>
        </div>
      )}
      <div className="notes-grid">
        <section className="card">
          <div className="card-head">
            <h2>{t('notes.title')}</h2>
            <div className="row-actions">
              <button className="btn ghost small" onClick={createNote}>
                {t('notes.new')}
              </button>
              <button className="btn ghost small" onClick={() => void recoverNotes()} disabled={recovering}>
                {t('notes.recoverFromRegistry')}
              </button>
            </div>
          </div>
          {notes.length === 0 ? (
            <p className="muted">{t('notes.empty')}</p>
          ) : (
            <div className="note-list">
              {notes.map((n) => (
                <div key={n.id} className={`note-item ${n.id === activeId ? 'active' : ''}`}>
                  <button className="note-item-main" onClick={() => void openNote(n)}>
                    <div className="title">{n.title || t('common.untitled')}</div>
                    <div className="meta">
                      {n.versions.length > 0 ? versionCount(n.versions.length) : t('notes.notPublished')} · {new Date(n.updatedAt).toLocaleString()}
                    </div>
                  </button>
                  <button className="btn link danger note-item-delete" title={t('notes.deleteLocalTitle')} onClick={() => void removeNote(n)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="privacy-note">
            {t('notes.privacyVersioned')}
            <Hint>{t('notes.hintVersions')}</Hint>
          </p>
        </section>

        <section className="card">
          {!activeNote ? (
            <p className="muted">{t('notes.pickNote')}</p>
          ) : (
            <>
              <div className="card-head">
                <h2>{t('notes.editTitle')}</h2>
                {rowBusy && <span className="small-text row-status">{rowBusy}</span>}
              </div>
              <label className="field">
                <span>{t('notes.titleLabel')}</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.untitled')} spellCheck={false} />
              </label>
              <label className="field">
                <span>{t('notes.contentLabel')}</span>
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} spellCheck={false} />
              </label>
              <div className="row">
                <button className="btn primary" onClick={() => void requestSave()} disabled={!!session && session.stage !== 'error'}>
                  {t('notes.saveNewVersion')}
                </button>
                <button className="btn ghost" onClick={() => void saveDraftLocal()}>
                  {t('notes.saveDraft')}
                </button>
              </div>
              <p className="privacy-note">
                {t('notes.privacyPlaintext')}
                <Hint>{t('notes.hintPlaintext')}</Hint>
              </p>

              {session && (
                <div className="upload-session">
                  {session.stage === 'awaiting-confirm' && session.prepared && session.fee && session.devFee ? (
                    <div className="confirm-panel">
                      <div className="kv">
                        <span>{t('notes.newVersionLabel')}</span>
                        <span>
                          v{session.version} · {nodeCount(session.prepared.nodes.length)} · {formatBytes(session.prepared.totalBytes)}
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
                      <p className="warning">{t('notes.warningVersions')}</p>
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
                      {session.stage === 'packing' ? t('stage.packingPlain') : t('stage.publishing')}
                      {session.detail ? <span className="muted"> · {session.detail}</span> : null}
                    </div>
                  )}
                </div>
              )}

              {activeNote.versions.length > 0 && (
                <>
                  <h2 style={{ marginTop: 18, fontSize: 14 }}>{t('notes.versionHistory', [activeNote.versions.length])}</h2>
                  <table className="files-table">
                    <thead>
                      <tr>
                        <th>{t('notes.thVersion')}</th>
                        <th>{t('common.size')}</th>
                        <th>{t('notes.thSaved')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...activeNote.versions].reverse().map((v) => (
                        <tr key={v.rootCid}>
                          <td>v{v.version}</td>
                          <td>{formatBytes(v.size)}</td>
                          <td className="small-text">{new Date(v.savedAt).toLocaleString()}</td>
                          <td>
                            <div className="row-actions">
                              <button className="btn small" onClick={() => void downloadVersion(v)}>
                                {t('common.download')}
                              </button>
                              <button className="btn ghost small" onClick={() => void restoreVersion(v)}>
                                {t('notes.restoreDraft')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
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
