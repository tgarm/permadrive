// My Files: upload (pack → fee confirmation → sign → confirm → background
// archive watch), download/retrieval, manifest import/export. The manifest
// set lives in IndexedDB (rootCid key); archive (indexer mapping) progress is
// local task state, never part of the manifest.
// Row action "sync to the on-chain registry" (republish the manifest + the
// FileRegistry entry) and "recover from the on-chain registry" (read the
// registry → block scan → restore the manifest set).
// Encrypted upload: K + AES-GCM → the ciphertext is packed into the standard
// DAG → the manifest v2 encryption block. Download decrypts via the signature
// channel first, falling back to a passphrase dialog.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { formatBytes, sha256Hex } from '../lib/bytes'
import { loadConfig } from '../lib/config'
import { migrateManifest, type Manifest } from '../lib/manifest'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload, type PublishOverrides, type PublishStage } from '../lib/publish'
import { retrieveFile } from '../lib/retrieve'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { IndexerClient } from '../lib/indexer'
import { signEvmMessage } from '../lib/vault'
import {
  addPassphraseChannel,
  addSignatureChannel,
  decryptFileBytes,
  requireChannel,
  startEncryption,
  type EncryptSession,
} from '../lib/fileCrypto'
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
  type PublishTaskRecord,
  type RegistryRecord,
  type TaskRecord,
} from '../lib/store'
import { dismissPendingPublish, listPendingPublish, verifyPublishTask } from '../lib/publish'
import { saveBlob } from '../lib/download'
import { PaywallSection } from './PaywallSection'
import { nodeCount, t, useI18n } from '../i18n'

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // per-file cap; larger files need chunking (a later version)

interface UploadSession {
  fileName: string
  fileSize: number
  stage: 'packing' | 'awaiting-confirm' | PublishStage | 'error'
  detail?: string
  error?: string
  prepared?: PreparedUpload
  fee?: { shannons: bigint; ai3: number }
  /** Encrypted upload session: plainSha256/plainSize/plainMimeType override manifest.file metadata; encSession gets wrap channels appended at confirm */
  encrypt?: boolean
  plainSha256?: string
  plainSize?: number
  plainMimeType?: string | null
  encSession?: EncryptSession
}

type RowBusy = Record<string, string>

export function FilesPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active: activeSigner, evm: evmSigner } = useSigner()
  const [manifests, setManifests] = useState<Manifest[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [registryRecords, setRegistryRecords] = useState<RegistryRecord[]>([])
  const [upload, setUpload] = useState<UploadSession | null>(null)
  const [rowBusy, setRowBusy] = useState<RowBusy>({})
  const [syncing, setSyncing] = useState<Set<string>>(new Set()) // rootCids with a sync in flight (explicit state, never matched by copy)
  const [notice, setNotice] = useState<string | null>(null)
  const [recoverState, setRecoverState] = useState<string | null>(null)
  const [recoverBusy, setRecoverBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [encryptOn, setEncryptOn] = useState(false)
  const [uploadPassphrase, setUploadPassphrase] = useState('')
  // passphrase fallback dialog for download decryption (suspends the decrypt promise)
  const [passPrompt, setPassPrompt] = useState<{ resolve: (v: string | null) => void } | null>(null)
  const [passPromptValue, setPassPromptValue] = useState('')
  // publish results pending verification (R02: rescan by hash on unknown
  // results — never auto-resend)
  const [pendingPublish, setPendingPublish] = useState<PublishTaskRecord[]>([])
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const watching = useRef(new Set<string>())

  const refreshPendingPublish = useCallback(async () => {
    setPendingPublish(await listPendingPublish())
  }, [])

  const refresh = useCallback(async () => {
    const [ms, ts, rs] = await Promise.all([listManifests(), listTasks(), listRegistryRecords()])
    setManifests(ms.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)))
    setTasks(ts.filter((x) => x.kind === 'archive-watch')) // publish tasks are tracked by pendingPublish
    setRegistryRecords(rs)
  }, [])

  const verifyPending = async (record: PublishTaskRecord) => {
    setVerifyingId(record.id)
    try {
      const api = await connect()
      const manifest = await verifyPublishTask(api, record)
      if (manifest) {
        await putManifest(manifest)
        setNotice(t('publishPending.recovered', [manifest.file.name]))
      } else {
        setNotice(t('publishPending.notFound'))
      }
    } catch (e) {
      setNotice(`✗ ${(e as Error).message}`)
    } finally {
      setVerifyingId(null)
      await refreshPendingPublish()
      await refresh()
    }
  }

  const dismissPending = async (record: PublishTaskRecord) => {
    if (!window.confirm(t('publishPending.dismissConfirm'))) return
    await dismissPendingPublish(record)
    await refreshPendingPublish()
  }

  const watchArchive = useCallback(
    async (manifest: Manifest) => {
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
      // indexer polling runs as a background task — it must not block the UI (measured 100s–2h; the data is retrievable on-chain meanwhile)
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
        // a polling crash keeps the task record; the next page visit restarts it
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
      // restart unfinished archive watches (they survive reload/close)
      const [ts, ms] = [await listTasks(), await listManifests()]
      for (const tk of ts.filter((x) => x.kind === 'archive-watch' && !x.done)) {
        const manifest = ms.find((m) => m.rootCid === tk.id) ?? (await getManifest(tk.id))
        if (manifest) void watchArchive(manifest)
        else await deleteTask(tk.id)
      }
      await refreshPendingPublish()
    })
  }, [refresh, watchArchive, refreshPendingPublish])

  const pickFile = async (file: File) => {
    setNotice(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setUpload({ fileName: file.name, fileSize: file.size, stage: 'error', error: t('files.maxSizeError', [formatBytes(MAX_UPLOAD_BYTES)]) })
      return
    }
    if (encryptOn) {
      if (!evmSigner) {
        setUpload({ fileName: file.name, fileSize: file.size, stage: 'error', error: t('files.encryptNeedEvm') })
        return
      }
      // Encrypted path: K + GCM (no signer needed) → the ciphertext is packed
      // into the standard DAG; wrap channels are appended at confirm time
      // (determinism self-check + optional passphrase)
      setUpload({ fileName: file.name, fileSize: file.size, stage: 'packing' })
      try {
        const plain = new Uint8Array(await file.arrayBuffer())
        const plainSha256 = await sha256Hex(plain)
        const encSession = await startEncryption(plain)
        const cipherCopy = new Uint8Array(encSession.cipher.length)
        cipherCopy.set(encSession.cipher)
        const cipherFile = new File([cipherCopy], file.name, { type: file.type || 'application/octet-stream' })
        const prepared = await prepareUpload(cipherFile)
        const api = await connect()
        const fee = await estimateFee(api, prepared.totalBytes)
        setUpload((u) => (u ? { ...u, prepared, fee, encrypt: true, plainSha256, plainSize: file.size, plainMimeType: file.type || null, encSession, stage: 'awaiting-confirm' } : u))
      } catch (e) {
        setUpload((u) => (u ? { ...u, stage: 'error', error: (e as Error).message } : u))
      }
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
      setUpload({ ...u, stage: 'error', error: t('files.noSignerUpload') })
      return
    }
    try {
      const api = await connect()
      let overrides: PublishOverrides = {}
      if (u.encrypt) {
        if (!u.encSession || !evmSigner) {
          setUpload({ ...u, stage: 'error', error: t('files.encryptNeedEvm') })
          return
        }
        setUpload((cur) => (cur ? { ...cur, stage: 'signing', detail: t('stage.keyWrap') } : cur))
        // Signature channel (determinism self-check; always true for local
        // keys) + optional passphrase channel; an injected wallet that fails
        // the check with no passphrase → requireChannel throws and prompts
        await addSignatureChannel(u.encSession, evmSigner.address, (msg) => signEvmMessage(evmSigner, msg))
        if (uploadPassphrase) await addPassphraseChannel(u.encSession, uploadPassphrase)
        requireChannel(u.encSession)
        overrides = { file: { sha256: u.plainSha256, size: u.plainSize, mimeType: u.plainMimeType }, encryption: u.encSession.encryption }
      }
      const manifest = await publishPrepared(
        api,
        u.prepared,
        activeSigner,
        (stage, detail) => setUpload((cur) => (cur ? { ...cur, stage, detail } : cur)),
        overrides,
      )
      await putManifest(manifest)
      setUpload(null)
      setUploadPassphrase('')
      setNotice(t('files.publishedNotice', [manifest.txs[0].height, manifest.txs[0].txHash.slice(0, 18) + '…']))
      void watchArchive(manifest)
      await refresh()
    } catch (e) {
      setUpload((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
      await refreshPendingPublish() // a publish task may have been persisted (pending verification)
    }
  }

  // Passphrase fallback dialog for download decryption: promise-based, the decrypt flow awaits it; cancel resolves null
  const openPassphrasePrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      setPassPromptValue('')
      setPassPrompt({ resolve })
    })

  const download = async (manifest: Manifest) => {
    setNotice(null)
    setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.retrieving') }))
    try {
      const api = await connect()
      const result = await retrieveFile(api, manifest)
      if (manifest.encryption) {
        // v2 encrypted file: verify ciphertext integrity first (retrieve checks
        // cipherSha256/cipherSize), then decrypt and check the plaintext sha256
        // (manifest.file.sha256)
        if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.decrypting') }))
        const signMessage = evmSigner ? (msg: string) => signEvmMessage(evmSigner, msg) : null
        const plain = await decryptFileBytes(result.bytes, manifest.encryption, signMessage, openPassphrasePrompt)
        const plainSha = await sha256Hex(plain)
        saveBlob(plain, manifest.file.name, manifest.file.mimeType)
        setRowBusy((b) => ({
          ...b,
          [manifest.rootCid]: plainSha === manifest.file.sha256 ? t('files.sha256Match', [plainSha.slice(0, 16)]) : t('files.sha256Mismatch', [plainSha]),
        }))
        return
      }
      saveBlob(result.bytes, manifest.file.name, manifest.file.mimeType)
      setRowBusy((b) => ({
        ...b,
        [manifest.rootCid]: result.sha256Match ? t('files.sha256Match', [result.sha256.slice(0, 16)]) : t('files.sha256Mismatch', [result.sha256]),
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
      setNotice(t('files.importNotice', [manifest.file.name, nodeCount(manifest.nodes.length)]))
    } catch (e) {
      setNotice(t('files.importFailed', [(e as Error).message]))
    }
  }

  const exportManifest = (manifest: Manifest) => {
    saveBlob(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), `${manifest.file.name}.manifest.json`, 'application/json')
  }

  // ---- On-chain registry (FileRegistry on Auto-EVM) ----

  const syncedRootCids = new Set(registryRecords.map((r) => r.rootCid))

  // Sync = republish the manifest into the DSN (Substrate signature) + registry entry (EVM signature)
  const syncToRegistry = async (manifest: Manifest) => {
    setNotice(null)
    if (!activeSigner) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.needSubstrate') }))
      return
    }
    if (!evmSigner) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.needEvm') }))
      return
    }
    const existing = registryRecords.find((r) => r.rootCid === manifest.rootCid)
    if (existing) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.alreadyHosted', [existing.manifestCid.slice(0, 16), existing.height]) }))
      return
    }
    setSyncing((s) => new Set(s).add(manifest.rootCid))
    try {
      const api = await connect()
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('stage.packingManifest') }))
      const publication = await publishManifestToChain(api, manifest, activeSigner, (stage, detail) => {
        // manifest publication uses different progress copy than content upload (it emphasizes the manifest itself)
        const text = {
          signing: t('stage.manifestSigning'),
          submitting: t('stage.manifestSubmitting'),
          submitted: t('stage.submitted'),
          scanning: t('stage.manifestScanning'),
          confirming: t('stage.manifestConfirming'),
          'packing-manifest': t('stage.packingManifest'),
        }[stage] ?? stage
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: detail ? `${text} ${detail}` : text }))
      })
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.manifestPublished', [publication.height]) }))
      // dev fee = max(minFee, 10% of the storage-fee estimate); quoted before payment
      const fee = await quoteRegisterFee(manifest.file.size)
      const feeAi3 = (Number(fee) / 1e18).toFixed(4)
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.registering', [feeAi3]) }))
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
          ? t('files.registeredAlready')
          : t('files.registeredDone', [publication.height, feeAi3, reg.txHash.slice(0, 14) + '…']),
      }))
    } catch (e) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `✗ ${(e as Error).message}` }))
    } finally {
      setSyncing((s) => {
        const next = new Set(s)
        next.delete(manifest.rootCid)
        return next
      })
    }
  }

  // Recover = read registry entries → block scan to restore manifests → store (the cross-device main path)
  const recoverFromRegistry = async () => {
    setNotice(null)
    if (!evmSigner) {
      setRecoverState(t('files.recoverNeedEvm'))
      return
    }
    setRecoverBusy(true)
    try {
      setRecoverState(t('files.readingRegistry'))
      const entries = await fetchEntries(evmSigner.address)
      if (entries.length === 0) {
        setRecoverState(t('files.registryEmpty', [evmSigner.address.slice(0, 10) + '…']))
        return
      }
      const api = await connect()
      const known = new Set((await listManifests()).map((m) => m.rootCid))
      let recovered = 0
      let skipped = 0
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        setRecoverState(t('files.recoveringItem', [i + 1, entries.length, entry.name, entry.height]))
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
          setRecoverState(t('files.recoverFailed', [entry.name, (e as Error).message]))
          return
        }
      }
      await refresh()
      setRecoverState(
        t('files.recoverDone', [
          t(recovered === 1 ? 'files.oneNewFile' : 'files.nNewFiles', [recovered]),
          skipped > 0 ? t('files.skippedSuffix', [skipped]) : '',
          entries.length,
        ]),
      )
    } catch (e) {
      setRecoverState(`✗ ${(e as Error).message}`)
    } finally {
      setRecoverBusy(false)
    }
  }

  const removeManifest = async (manifest: Manifest) => {
    if (!window.confirm(t('files.deleteConfirm', [manifest.file.name]))) return
    await deleteManifest(manifest.rootCid)
    await deleteTask(manifest.rootCid)
    await refresh()
  }

  const taskByRoot = new Map(tasks.map((tk) => [tk.id, tk]))

  return (
    <div className="page">
      <section className="card upload-card">
        <h2>{t('files.uploadTitle')}</h2>
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
            {t('files.chooseFile')}
          </button>
          <span className="muted">{t('files.dropHint', [formatBytes(MAX_UPLOAD_BYTES)])}</span>
        </div>

        <div className="encrypt-toggle-row">
          <label>
            <input type="checkbox" checked={encryptOn} onChange={(e) => setEncryptOn(e.target.checked)} />
            <span>🔒 {t('files.encryptToggle')}</span>
          </label>
          <Hint>{t('files.encryptToggleHint')}</Hint>
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
                  <span>{t('files.rootCid')}</span>
                  <span className="mono small-text">{upload.prepared.rootCid}</span>
                </div>
                <div className="kv">
                  <span>{t('files.ipldNodes')}</span>
                  <span>{t('files.nodesOnChain', [nodeCount(upload.prepared.nodes.length), formatBytes(upload.prepared.totalBytes)])}</span>
                </div>
                <div className="kv fee">
                  <span>{t('files.feeEstimate')}</span>
                  <span>≈ {upload.fee.ai3.toFixed(4)} AI3</span>
                </div>
                {upload.encrypt && (
                  <>
                    <div className="kv">
                      <span>{t('files.encryptionLabel')}</span>
                      <span>🔒 {t('files.encryptedBadge')}</span>
                    </div>
                    <div className="kv">
                      <span>{t('files.passphraseChannel')}</span>
                      <input
                        type="password"
                        value={uploadPassphrase}
                        placeholder={t('files.passphrasePlaceholder')}
                        onChange={(e) => setUploadPassphrase(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <p className="warning">{t('files.warningPermanent')}</p>
                {upload.encrypt && <p className="warning">{t('files.encryptPrivacy')}</p>}
                <div className="row">
                  <button className="btn primary" onClick={() => void confirmUpload()}>
                    {t('files.signAndUpload')}
                  </button>
                  <button className="btn ghost" onClick={() => setUpload(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : upload.stage === 'error' ? (
              <div>
                <div className="error-text">{upload.error}</div>
                <button className="btn ghost small" onClick={() => setUpload(null)}>
                  {t('common.close')}
                </button>
              </div>
            ) : (
              <div className="stage-line">
                {stageText(upload.stage)}
                {upload.detail ? <span className="muted"> · {upload.detail}</span> : null}
              </div>
            )}
          </div>
        )}

        <p className="privacy-note">
          {t('files.privacyShort')}
          <Hint>
            {t('files.hintSyncTitle')}
            <br />
            {t('files.hintSyncBody')}
          </Hint>
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{t('files.myFiles')}</h2>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => importInputRef.current?.click()}>
              {t('files.importManifest')}
            </button>
            <button className="btn ghost small" onClick={() => void recoverFromRegistry()} disabled={recoverBusy}>
              {t('files.recoverFromRegistry')}
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
        {pendingPublish.length > 0 && (
          <div className="notice">
            <div>{t('publishPending.title', [String(pendingPublish.length)])}</div>
            {pendingPublish.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="muted small-text">
                  {t('publishPending.detail', [p.file.name, String(p.txHashes.length), String(p.startHeight)])}
                </span>
                <button className="btn small" disabled={verifyingId === p.id} onClick={() => void verifyPending(p)}>
                  {verifyingId === p.id ? t('publishPending.verifying') : t('publishPending.verify')}
                </button>
                <button className="btn ghost small" disabled={verifyingId === p.id} onClick={() => void dismissPending(p)}>
                  {t('publishPending.dismiss')}
                </button>
              </div>
            ))}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}
        {recoverState && <div className="notice">{recoverState}</div>}
        {manifests.length === 0 ? (
          <p className="muted">{t('files.empty')}</p>
        ) : (
          <table className="files-table">
            <thead>
              <tr>
                <th>{t('files.thFile')}</th>
                <th>{t('common.size')}</th>
                <th>{t('files.thDsn')}</th>
                <th>{t('files.thRegistry')}</th>
                <th>{t('files.thPublished')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {manifests.map((m) => {
                const task = taskByRoot.get(m.rootCid)
                return (
                  <tr key={m.rootCid}>
                    <td>
                      <div className="file-name">
                        {m.encryption ? '🔒 ' : ''}
                        {m.file.name}
                      </div>
                      <div className="mono small-text muted">{m.rootCid.slice(0, 24)}…</div>
                      {rowBusy[m.rootCid] && <div className="small-text row-status">{rowBusy[m.rootCid]}</div>}
                    </td>
                    <td>{formatBytes(m.file.size)}</td>
                    <td>
                      {!task ? (
                        <span className="muted">{t('files.archiveUnknown')}</span>
                      ) : task.done ? (
                        <span className="ok">{t('files.archived')}</span>
                      ) : (
                        <span>
                          {task.indexed}/{task.total} {t('files.indexed')}
                        </span>
                      )}
                    </td>
                    <td>
                      {syncedRootCids.has(m.rootCid) ? (
                        <span className="ok">{t('files.registered')}</span>
                      ) : (
                        <span className="muted">{t('files.notRegistered')}</span>
                      )}
                    </td>
                    <td className="small-text">{new Date(m.submittedAt).toLocaleString()}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small" onClick={() => void download(m)}>
                          {t('common.download')}
                        </button>
                        <button className="btn ghost small" onClick={() => exportManifest(m)}>
                          {t('files.manifestBtn')}
                        </button>
                        <button className="btn ghost small" onClick={() => void syncToRegistry(m)} disabled={syncing.has(m.rootCid)}>
                          {t('files.syncRegistry')}
                        </button>
                        <button className="btn ghost small danger" onClick={() => void removeManifest(m)}>
                          {t('common.delete')}
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
          {t('files.privacyRegistry')}
          <Hint>{t('files.hintRegistry')}</Hint>
        </p>
      </section>

      <PaywallSection getPassphrase={openPassphrasePrompt} />

      {passPrompt && (
        <div
          className="modal-overlay"
          onMouseDown={() => {
            passPrompt.resolve(null)
            setPassPrompt(null)
          }}
        >
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{t('files.passphrasePromptTitle')}</h3>
            <p className="muted small-text">{t('files.passphrasePromptBody')}</p>
            <input
              type="password"
              autoFocus
              value={passPromptValue}
              onChange={(e) => setPassPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && passPromptValue) {
                  passPrompt.resolve(passPromptValue)
                  setPassPrompt(null)
                }
              }}
            />
            <div className="row">
              <button
                className="btn primary"
                disabled={!passPromptValue}
                onClick={() => {
                  passPrompt.resolve(passPromptValue)
                  setPassPrompt(null)
                }}
              >
                {t('common.ok')}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  passPrompt.resolve(null)
                  setPassPrompt(null)
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Upload session progress line: stage is a stable identifier, copy comes from the dictionary (stage.*)
function stageText(stage: UploadSession['stage']): string {
  const map: Record<string, string> = {
    packing: 'stage.packing',
    'awaiting-confirm': 'stage.awaitingConfirm',
    signing: 'stage.signing',
    submitting: 'stage.submitting',
    submitted: 'stage.submitted',
    scanning: 'stage.scanning',
    confirming: 'stage.confirming',
  }
  return map[stage] ? t(map[stage]) : stage
}
