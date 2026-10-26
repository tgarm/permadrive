// Versioned text: note list on the left, editor on the right. Save = pack and
// publish the content → re-publish the manifest → register in the registry
// (every version bills normally; fee quote panel first). Version history is
// recovered from registry entries (pdnote- naming convention grouping); the
// local IndexedDB is only a cache. Content goes on-chain in plaintext (same
// model as "My files") — private text belongs in the encrypted vault.

import { useCallback, useEffect, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { formatBytes } from '../lib/bytes'
import { newNoteId, noteFileName, parseNoteFileName, groupNoteEntries, titleFromSlug } from '../lib/notes'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload } from '../lib/publish'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { retrieveFile } from '../lib/retrieve'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { deleteNote, getManifest, listNotes, putManifest, putNote, type NoteRecord, type NoteVersionRecord } from '../lib/store'

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
      setRowBusy(`Fetching latest version (v${latest.version})…`)
      try {
        const text = await fetchVersionText(latest)
        setContent(text)
        await putNote({ ...note, content: text })
        setRowBusy(null)
      } catch (e) {
        setRowBusy(`✗ content fetch failed: ${(e as Error).message}`)
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
    if (!result.sha256Match) throw new Error(`sha256 mismatch (${result.sha256.slice(0, 16)}…)`)
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
      setNotice('✗ content is empty')
      return
    }
    if (!active || !evm) {
      setNotice('✗ needs a Substrate signer (publishing) and an EVM signer (registry)')
      return
    }
    const note = notes.find((n) => n.id === activeId)
    if (!note) return
    const version = note.versions.length + 1
    // No version number in the filename (it feeds content addressing): saving
    // identical content under the same title is idempotent and free
    const name = noteFileName(note.id, title || 'Untitled')
    setSession({ noteId: note.id, version, name, stage: 'packing' })
    try {
      const file = new File([content], name, { type: 'text/markdown' })
      const prepared = await prepareUpload(file)
      const last = note.versions[note.versions.length - 1]
      if (last && last.rootCid === prepared.rootCid) {
        setSession(null)
        setNotice('✓ content unchanged (same CID under content addressing), no new version needed')
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
        const text = { signing: 'waiting for wallet signature…', submitting: 'submitted, waiting for a block…', scanning: 'scanning for the tx…', confirming: 'waiting for confirmations (12 blocks)…' }[stage] ?? stage
        setSession((cur) => (cur ? { ...cur, stage: 'publishing', detail: detail ? `${text} ${detail}` : text } : cur))
      })
      await putManifest(manifest)
      setSession((cur) => (cur ? { ...cur, detail: 'publishing manifest file…' } : cur))
      // 2) manifest re-published into the DSN (registry entry locator, same path as "My files" sync)
      const publication = await publishManifestToChain(api, manifest, active, (_stage, detail) =>
        setSession((cur) => (cur ? { ...cur, stage: 'publishing', detail } : cur)),
      )
      // 3) registry register (dev fee)
      setSession((cur) => (cur ? { ...cur, detail: `registering (dev fee ${s.devFee!.ai3} AI3)…` } : cur))
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
      setNotice(`✓ v${s.version} published: content block #${manifest.txs[0].height} · dev fee ${s.devFee.ai3} AI3 · registry tx ${publication.txHash.slice(0, 14)}…`)
      await refresh()
    } catch (e) {
      setSession((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
    }
  }

  // ---- version actions ----

  const downloadVersion = async (version: NoteVersionRecord) => {
    setNotice(null)
    setRowBusy('fetching from chain…')
    try {
      const api = await connect()
      let manifest = await getManifest(version.rootCid)
      if (!manifest) manifest = await recoverManifestFromHint(api, version.manifestCid, version.height)
      const result = await retrieveFile(api, manifest)
      saveBlob(result.bytes, version.name, 'text/markdown')
      setRowBusy(result.sha256Match ? `✓ v${version.version} sha256 match` : `✗ v${version.version} sha256 mismatch!`)
    } catch (e) {
      setRowBusy(`✗ ${(e as Error).message}`)
    }
  }

  const restoreVersion = async (version: NoteVersionRecord) => {
    setNotice(null)
    setRowBusy(`fetching v${version.version}…`)
    try {
      const text = await fetchVersionText(version)
      setContent(text)
      setTitle(titleFromSlug(parseNoteFileName(version.name)?.titleSlug ?? ''))
      setRowBusy(`✓ v${version.version} loaded into the editor (not published; saving creates a new version)`)
    } catch (e) {
      setRowBusy(`✗ ${(e as Error).message}`)
    }
  }

  // ---- recover from the on-chain registry (the version chain's authority) ----

  const recoverNotes = async () => {
    setNotice(null)
    if (!evm) {
      setNotice('✗ connect an EVM signer first (the wallet of the on-chain registry)')
      return
    }
    setRecovering(true)
    try {
      setNotice('reading the on-chain registry…')
      const entries = await fetchEntries(evm.address)
      const groups = groupNoteEntries(entries)
      if (groups.size === 0) {
        setNotice(`no note entries in the registry (${entries.length} registrations total)`)
        return
      }
      const api = await connect()
      let newNotes = 0
      let newVersions = 0
      let idx = 0
      for (const [id, groupEntries] of groups) {
        idx++
        setNotice(`recovering note ${idx}/${groups.size} (${groupEntries.length} versions)…`)
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
      setNotice(`✓ recovery complete: ${newNotes} new note${newVersions > 0 ? ` · ${newVersions} new version${newVersions === 1 ? '' : 's'}` : ''} (${groups.size} total)`)
    } catch (e) {
      setNotice(`✗ ${(e as Error).message}`)
    } finally {
      setRecovering(false)
    }
  }

  const removeNote = async (note: NoteRecord) => {
    if (!window.confirm(`Delete the local record for "${note.title || 'Untitled'}"? (on-chain versions are unaffected; recover from the registry anytime)`)) return
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
            <h2>Notes</h2>
            <div className="row-actions">
              <button className="btn ghost small" onClick={createNote}>
                New
              </button>
              <button className="btn ghost small" onClick={() => void recoverNotes()} disabled={recovering}>
                Recover from registry
              </button>
            </div>
          </div>
          {notes.length === 0 ? (
            <p className="muted">No notes yet. Create one, or recover from the on-chain registry.</p>
          ) : (
            <div className="note-list">
              {notes.map((n) => (
                <div key={n.id} className={`note-item ${n.id === activeId ? 'active' : ''}`}>
                  <button className="note-item-main" onClick={() => void openNote(n)}>
                    <div className="title">{n.title || 'Untitled'}</div>
                    <div className="meta">
                      {n.versions.length > 0 ? `${n.versions.length} version${n.versions.length === 1 ? '' : 's'}` : 'not published'} ·{' '}
                      {new Date(n.updatedAt).toLocaleString()}
                    </div>
                  </button>
                  <button className="btn link danger note-item-delete" title="Delete the local record" onClick={() => void removeNote(n)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="privacy-note">The version history lives in the on-chain registry (FileRegistry v2, grouped by the pdnote- naming convention).</p>
        </section>

        <section className="card">
          {!activeNote ? (
            <p className="muted">Pick a note on the left, or click "New".</p>
          ) : (
            <>
              <div className="card-head">
                <h2>Edit</h2>
                {rowBusy && <span className="small-text row-status">{rowBusy}</span>}
              </div>
              <label className="field">
                <span>Title (encoded into the filename, bound to the version once published)</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" spellCheck={false} />
              </label>
              <label className="field">
                <span>Content (Markdown plaintext, published in the clear — permanently public, no secrets)</span>
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} spellCheck={false} />
              </label>
              <div className="row">
                <button className="btn primary" onClick={() => void requestSave()} disabled={!!session && session.stage !== 'error'}>
                  Save as new version
                </button>
                <button className="btn ghost" onClick={() => void saveDraftLocal()}>
                  Save local draft only
                </button>
              </div>

              {session && (
                <div className="upload-session">
                  {session.stage === 'awaiting-confirm' && session.prepared && session.fee && session.devFee ? (
                    <div className="confirm-panel">
                      <div className="kv">
                        <span>New version</span>
                        <span>
                          v{session.version} · {session.prepared.nodes.length} node{session.prepared.nodes.length === 1 ? '' : 's'} ·{' '}
                          {formatBytes(session.prepared.totalBytes)}
                        </span>
                      </div>
                      <div className="kv fee">
                        <span>On-chain storage fee (estimate)</span>
                        <span>≈ {session.fee.ai3.toFixed(4)} AI3</span>
                      </div>
                      <div className="kv fee">
                        <span>Registry dev fee</span>
                        <span>{session.devFee.ai3} AI3</span>
                      </div>
                      <p className="warning">
                        Every version is permanently public and cannot be deleted (append-only); for small texts the cost is mostly the 0.01 AI3 registry floor.
                      </p>
                      <div className="row">
                        <button className="btn primary" onClick={() => void confirmSave()}>
                          Sign and publish
                        </button>
                        <button className="btn ghost" onClick={() => setSession(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : session.stage === 'error' ? (
                    <div>
                      <div className="error-text">{session.error}</div>
                      <button className="btn ghost small" onClick={() => setSession(null)}>
                        Close
                      </button>
                    </div>
                  ) : (
                    <div className="stage-line">
                      {session.stage === 'packing' ? 'packing locally…' : 'publishing…'}
                      {session.detail ? <span className="muted"> · {session.detail}</span> : null}
                    </div>
                  )}
                </div>
              )}

              {activeNote.versions.length > 0 && (
                <>
                  <h2 style={{ marginTop: 18, fontSize: 14 }}>Version history ({activeNote.versions.length})</h2>
                  <table className="files-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Size</th>
                        <th>Saved</th>
                        <th>Actions</th>
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
                                Download
                              </button>
                              <button className="btn ghost small" onClick={() => void restoreVersion(v)}>
                                Restore as draft
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
