// My Files: upload (pack -> fee confirmation -> sign -> confirm -> background
// archive watch), download/retrieval, manifest import/export. The manifest
// collection lives in IndexedDB (keyed by rootCid); archive (indexer mapping)
// progress is local task state, not part of the manifest.
// Row action "Sync registry" (re-publishes the manifest to the DSN + registers
// it in FileRegistry); toolbar "Recover from on-chain registry" (reads the
// Registry -> block-scans to rebuild the manifest collection).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { formatBytes } from '../lib/bytes'
import { loadConfig } from '../lib/config'
import { migrateManifest, type ManifestV1 } from '../lib/manifest'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload, type PublishStage } from '../lib/publish'
import { retrieveFile } from '../lib/retrieve'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { IndexerClient } from '../lib/indexer'
import {
  deleteManifest,
  deleteTask,
  getManifest,
  listManifests,
  listRegistryRecords,
  listTasks,
  putManifest,
  putRegistryRecord,
  putTask,
  type RegistryRecord,
  type TaskRecord,
} from '../lib/store'

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // single-file limit: larger files need chunked upload (not implemented yet)

interface UploadSession {
  fileName: string
  fileSize: number
  stage: 'packing' | 'awaiting-confirm' | PublishStage | 'error'
  detail?: string
  error?: string
  prepared?: PreparedUpload
  fee?: { shannons: bigint; ai3: number }
}

type RowBusy = Record<string, string>

const STAGE_TEXT: Record<string, string> = {
  packing: 'Packing locally (IPLD chunking)…',
  'awaiting-confirm': 'Awaiting fee confirmation',
  signing: 'Waiting for wallet signature…',
  submitting: 'Submitted, waiting for block inclusion…',
  scanning: 'Scanning the best chain to locate the transaction…',
  confirming: 'Waiting for block confirmations (12 blocks)…',
}

function saveBlob(bytes: Uint8Array, name: string, mimeType: string | null): void {
  // Copy into a standalone ArrayBuffer to work around TS's ArrayBufferLike constraint on BlobPart
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

export function FilesPage() {
  const { connect } = useChain()
  const { active: activeSigner, evm: evmSigner } = useSigner()
  const [manifests, setManifests] = useState<ManifestV1[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [registryRecords, setRegistryRecords] = useState<RegistryRecord[]>([])
  const [upload, setUpload] = useState<UploadSession | null>(null)
  const [rowBusy, setRowBusy] = useState<RowBusy>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [recoverState, setRecoverState] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const watching = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const [ms, ts, rs] = await Promise.all([listManifests(), listTasks(), listRegistryRecords()])
    setManifests(ms.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)))
    setTasks(ts)
    setRegistryRecords(rs)
  }, [])

  const watchArchive = useCallback(
    async (manifest: ManifestV1) => {
      if (watching.current.has(manifest.rootCid)) return
      watching.current.add(manifest.rootCid)
      const task: TaskRecord = {
        id: manifest.rootCid,
        kind: 'archive-watch',
        fileName: manifest.file.name,
        indexed: 0,
        total: manifest.nodes.length,
        done: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await putTask(task)
      await refresh()
      // The indexer poll runs as a background task so it never blocks the UI
      // (observed 100s–2h; the data is already retrievable on-chain at this point)
      const indexer = new IndexerClient(loadConfig().indexerUrl)
      try {
        const { found, pending } = await indexer.pollUntilIndexed(
          manifest.nodes.map((n) => n.blake3),
          {
            intervalMs: 30_000,
            timeoutMs: 2 * 60 * 60_000,
            onProgress: async (got) => {
              task.indexed = got
              task.updatedAt = Date.now()
              await putTask(task)
              await refresh()
            },
          },
        )
        task.indexed = found.size
        task.done = pending.length === 0
        task.updatedAt = Date.now()
        await putTask(task)
      } catch {
        // If the poll crashes, keep the task record — it restarts on the next page load
      } finally {
        indexer.close()
        watching.current.delete(manifest.rootCid)
        await refresh()
      }
    },
    [refresh],
  )

  useEffect(() => {
    void refresh().then(async () => {
      // Restart unfinished archive watches (resumes after refresh/close)
      const [ts, ms] = [await listTasks(), await listManifests()]
      for (const t of ts.filter((x) => !x.done)) {
        const manifest = ms.find((m) => m.rootCid === t.id) ?? (await getManifest(t.id))
        if (manifest) void watchArchive(manifest)
        else await deleteTask(t.id)
      }
    })
  }, [refresh, watchArchive])

  const pickFile = async (file: File) => {
    setNotice(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setUpload({ fileName: file.name, fileSize: file.size, stage: 'error', error: `Per-file limit is ${formatBytes(MAX_UPLOAD_BYTES)} (chunked uploads for larger files are planned)` })
      return
    }
    setUpload({ fileName: file.name, fileSize: file.size, stage: 'packing' })
    try {
      const prepared = await prepareUpload(file)
      const api = await connect()
      const fee = await estimateFee(api, prepared.totalBytes)
      setUpload((u) => (u ? { ...u, prepared, fee, stage: 'awaiting-confirm' } : u))
    } catch (e) {
      setUpload((u) => (u ? { ...u, stage: 'error', error: (e as Error).message } : u))
    }
  }

  const confirmUpload = async () => {
    const u = upload
    if (!u?.prepared || !u.fee || u.stage !== 'awaiting-confirm') return
    if (!activeSigner) {
      setUpload({ ...u, stage: 'error', error: 'No active signer (connect a wallet or use a local key)' })
      return
    }
    try {
      const api = await connect()
      const manifest = await publishPrepared(api, u.prepared, activeSigner, (stage, detail) =>
        setUpload((cur) => (cur ? { ...cur, stage, detail } : cur)),
      )
      await putManifest(manifest)
      setUpload(null)
      setNotice(`✓ Published on chain: block #${manifest.txs[0].height} · tx ${manifest.txs[0].txHash.slice(0, 18)}…`)
      void watchArchive(manifest)
      await refresh()
    } catch (e) {
      setUpload((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
    }
  }

  const download = async (manifest: ManifestV1) => {
    setNotice(null)
    setRowBusy((b) => ({ ...b, [manifest.rootCid]: 'Retrieving from chain…' }))
    try {
      const api = await connect()
      const result = await retrieveFile(api, manifest)
      saveBlob(result.bytes, manifest.file.name, manifest.file.mimeType)
      setRowBusy((b) => ({
        ...b,
        [manifest.rootCid]: result.sha256Match ? `✓ sha256 match (${result.sha256.slice(0, 16)}…)` : `✗ sha256 mismatch! ${result.sha256}`,
      }))
    } catch (e) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `✗ ${(e as Error).message}` }))
    }
  }

  const importManifest = async (file: File) => {
    setNotice(null)
    try {
      const manifest = migrateManifest(JSON.parse(await file.text()))
      await putManifest(manifest)
      await refresh()
      setNotice(`✓ Manifest imported: ${manifest.file.name} (${manifest.nodes.length} nodes)`)
    } catch (e) {
      setNotice(`✗ Import failed: ${(e as Error).message}`)
    }
  }

  const exportManifest = (manifest: ManifestV1) => {
    saveBlob(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), `${manifest.file.name}.manifest.json`, 'application/json')
  }

  // ---- on-chain registry (FileRegistry on Auto-EVM) ----

  const syncedRootCids = new Set(registryRecords.map((r) => r.rootCid))

  // Sync = re-publish the manifest to the DSN (Substrate signature) + register it in the Registry (EVM signature)
  const syncToRegistry = async (manifest: ManifestV1) => {
    setNotice(null)
    if (!activeSigner) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: '✗ Substrate signer required (publishes the manifest file)' }))
      return
    }
    if (!evmSigner) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: '✗ EVM signer required (registers the on-chain registry entry)' }))
      return
    }
    const existing = registryRecords.find((r) => r.rootCid === manifest.rootCid)
    if (existing) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `Registered (manifest ${existing.manifestCid.slice(0, 16)}… @block ${existing.height})` }))
      return
    }
    try {
      const api = await connect()
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: 'Packing manifest…' }))
      const publication = await publishManifestToChain(api, manifest, activeSigner, (stage, detail) => {
        const text = { signing: 'Waiting for wallet signature (publishing manifest)…', submitting: 'Manifest submitted…', scanning: 'Scanning blocks…', confirming: 'Waiting for confirmations (12 blocks)…' }[stage] ?? stage
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: detail ? `${text} ${detail}` : text }))
      })
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `Manifest published (block #${publication.height}), fetching registry fee quote…` }))
      // dev fee = max(minFee, 5% of the storage fee estimate); show the quote before paying
      const fee = await quoteRegisterFee(manifest.file.size)
      const feeAi3 = (Number(fee) / 1e18).toFixed(4)
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `Registering (dev fee ${feeAi3} AI3)…` }))
      const reg = await registerFile(
        evmSigner,
        {
          manifestCid: publication.manifestCid,
          height: publication.height,
          name: manifest.file.name,
          size: manifest.file.size,
        },
        { fee },
      )
      await putRegistryRecord({
        rootCid: manifest.rootCid,
        manifestCid: publication.manifestCid,
        height: publication.height,
        evmAddress: evmSigner.address,
        syncedAt: Date.now(),
      })
      await refresh()
      setRowBusy((b) => ({
        ...b,
        [manifest.rootCid]: reg.alreadyRegistered
          ? '✓ Registered (this manifest is already in the registry)'
          : `✓ Registered · manifest @block #${publication.height} · dev fee ${feeAi3} AI3 · tx ${reg.txHash.slice(0, 14)}…`,
      }))
    } catch (e) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `✗ ${(e as Error).message}` }))
    }
  }

  // Recover = read Registry entries -> block-scan to rebuild the manifests -> store
  // locally (the main cross-device recovery path)
  const recoverFromRegistry = async () => {
    setNotice(null)
    if (!evmSigner) {
      setRecoverState('✗ Connect an EVM signer first (the registry wallet)')
      return
    }
    try {
      setRecoverState('Reading the on-chain registry…')
      const entries = await fetchEntries(evmSigner.address)
      if (entries.length === 0) {
        setRecoverState(`Empty registry (${evmSigner.address.slice(0, 10)}… has no registrations)`)
        return
      }
      const api = await connect()
      const known = new Set((await listManifests()).map((m) => m.rootCid))
      let recovered = 0
      let skipped = 0
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        setRecoverState(`Recovering ${i + 1}/${entries.length}: ${entry.name} (block #${entry.height})…`)
        try {
          const manifest = await recoverManifestFromHint(api, entry.manifestCid, Number(entry.height))
          await putManifest(manifest)
          await putRegistryRecord({
            rootCid: manifest.rootCid,
            manifestCid: entry.manifestCid,
            height: Number(entry.height),
            evmAddress: evmSigner.address,
            syncedAt: Date.now(),
          })
          recovered += known.has(manifest.rootCid) ? 0 : 1
          skipped += known.has(manifest.rootCid) ? 1 : 0
        } catch (e) {
          setRecoverState(`✗ "${entry.name}" recovery failed: ${(e as Error).message}`)
          return
        }
      }
      await refresh()
      setRecoverState(
        `✓ Recovery complete: ${recovered} new file${recovered === 1 ? '' : 's'}${skipped > 0 ? ` · ${skipped} already present` : ''} (${entries.length} registrations total)`,
      )
    } catch (e) {
      setRecoverState(`✗ ${(e as Error).message}`)
    }
  }

  const removeManifest = async (manifest: ManifestV1) => {
    if (!window.confirm(`Delete the local index for "${manifest.file.name}"? (On-chain data is untouched; the manifest can be re-imported at any time)`)) return
    await deleteManifest(manifest.rootCid)
    await deleteTask(manifest.rootCid)
    await refresh()
  }

  const taskByRoot = new Map(tasks.map((t) => [t.id, t]))

  return (
    <div className="page">
      <section className="card upload-card">
        <h2>Upload</h2>
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files[0]
            if (f) void pickFile(f)
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void pickFile(f)
              e.target.value = ''
            }}
          />
          <button className="btn primary" onClick={() => fileInputRef.current?.click()}>
            Choose file
          </button>
          <span className="muted">or drag and drop here · single file ≤ {formatBytes(MAX_UPLOAD_BYTES)}</span>
        </div>

        {upload && (
          <div className="upload-session">
            <div className="upload-file">
              <strong>{upload.fileName}</strong>
              <span className="muted">{formatBytes(upload.fileSize)}</span>
            </div>
            {upload.stage === 'awaiting-confirm' && upload.prepared && upload.fee ? (
              <div className="confirm-panel">
                <div className="kv">
                  <span>root CID</span>
                  <span className="mono small-text">{upload.prepared.rootCid}</span>
                </div>
                <div className="kv">
                  <span>IPLD nodes</span>
                  <span>
                    {upload.prepared.nodes.length} nodes · {formatBytes(upload.prepared.totalBytes)} on chain
                  </span>
                </div>
                <div className="kv fee">
                  <span>On-chain fee (estimate)</span>
                  <span>≈ {upload.fee.ai3.toFixed(4)} AI3</span>
                </div>
                <p className="warning">Publishing is permanent and public — keep private content in the Vault.</p>
                <div className="row">
                  <button className="btn primary" onClick={() => void confirmUpload()}>
                    Sign and upload
                  </button>
                  <button className="btn ghost" onClick={() => setUpload(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : upload.stage === 'error' ? (
              <div>
                <div className="error-text">{upload.error}</div>
                <button className="btn ghost small" onClick={() => setUpload(null)}>
                  Close
                </button>
              </div>
            ) : (
              <div className="stage-line">
                {STAGE_TEXT[upload.stage] ?? upload.stage}
                {upload.detail ? <span className="muted"> · {upload.detail}</span> : null}
              </div>
            )}
          </div>
        )}

        <p className="privacy-note">
          Once published, anyone can read it and it cannot be deleted.
          <Hint>
            "Sync to registry" registers the file into your on-chain registry (a small registration fee per file, about
            10% of the storage fee with a 0.01 AI3 floor); on a new device, connect the same wallet and click "Recover
            from registry" to restore the file list.
            <br />
            Registering is optional — the file itself can always be fetched for free with its manifest or by scanning
            the chain. A manifest is a self-contained retrieval credential (it locates every data block); export it and
            any device can use it. Cost comparison on the About page.
          </Hint>
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>My Files</h2>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => importInputRef.current?.click()}>
              Import manifest
            </button>
            <button
              className="btn ghost small"
              onClick={() => void recoverFromRegistry()}
              disabled={!!recoverState && /Recovering/.test(recoverState)}
            >
              Recover from on-chain registry
            </button>
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importManifest(f)
              e.target.value = ''
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
        {recoverState && <div className="notice">{recoverState}</div>}
        {manifests.length === 0 ? (
          <p className="muted">No files yet. Upload, import a manifest, or recover from the on-chain registry.</p>
        ) : (
          <table className="files-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>DSN archive</th>
                <th>Registry</th>
                <th>Published</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {manifests.map((m) => {
                const task = taskByRoot.get(m.rootCid)
                return (
                  <tr key={m.rootCid}>
                    <td>
                      <div className="file-name">{m.file.name}</div>
                      <div className="mono small-text muted">{m.rootCid.slice(0, 24)}…</div>
                      {rowBusy[m.rootCid] && <div className="small-text row-status">{rowBusy[m.rootCid]}</div>}
                    </td>
                    <td>{formatBytes(m.file.size)}</td>
                    <td>
                      {!task ? (
                        <span className="muted">Unknown</span>
                      ) : task.done ? (
                        <span className="ok">✓ Archived</span>
                      ) : (
                        <span>
                          {task.indexed}/{task.total} indexed
                        </span>
                      )}
                    </td>
                    <td>
                      {syncedRootCids.has(m.rootCid) ? (
                        <span className="ok">✓ Registered</span>
                      ) : (
                        <span className="muted">Not registered</span>
                      )}
                    </td>
                    <td className="small-text">{new Date(m.submittedAt).toLocaleString()}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small" onClick={() => void download(m)}>
                          Download
                        </button>
                        <button className="btn ghost small" onClick={() => exportManifest(m)}>
                          Manifest
                        </button>
                        <button
                          className="btn ghost small"
                          onClick={() => void syncToRegistry(m)}
                          disabled={!!rowBusy[m.rootCid] && /Packing|sign|submitted|Scanning|confirm|Registering/.test(rowBusy[m.rootCid])}
                        >
                          Sync registry
                        </button>
                        <button className="btn ghost small danger" onClick={() => void removeManifest(m)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="privacy-note">
          The on-chain registry holds your file list — connect the same wallet on a new device to recover it in one click.
          <Hint>
            The registry is a public index (which wallet registered which files), not access control: published data
            itself is readable by anyone. Registration charges a dev fee (≈10% of the on-chain storage fee, 0.01 AI3
            floor) that funds the maintenance of the public frontend and tooling; skipping registration does not affect
            retrieving the data itself from the chain.
          </Hint>
        </p>
      </section>
    </div>
  )
}
