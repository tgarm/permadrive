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
// The upload card / file table / passphrase dialog / pending-publish notice
// are separate components (UploadCard / FilesTable / PassphrasePrompt /
// PendingPublishNotice); this file keeps the state shared across sections.
// Sharing: each file row carries a three-state badge and opens a per-file
// share panel; the dissolved SalesSection moved seller actions into the panel
// and buyer actions into the Share tab. The paid-download escrow frontend was
// removed entirely on 2026-10-31.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { sha256Hex } from '../lib/bytes'
import { loadConfig } from '../lib/config'
import { migrateManifest, type Manifest } from '../lib/manifest'
import { retrieveFile } from '../lib/retrieve'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { fetchEntries, quoteRegisterFee, registerFile } from '../lib/registry'
import { IndexerClient } from '../lib/indexer'
import { signEvmMessage } from '../lib/vault'
import { decryptFileBytes } from '../lib/fileCrypto'
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
import { FilesTable } from './FilesTable'
import { PassphrasePrompt } from './PassphrasePrompt'
import { PendingPublishNotice } from './PendingPublishNotice'
import { SharePanel } from './SharePanel'
import { UploadCard } from './UploadCard'
import { deriveShareInfo, type ShareInfo } from '../lib/shareState'
import { putManifestPublishMeta } from '../lib/manifestPublish'
import { nodeCount, useI18n } from '../i18n'

type RowBusy = Record<string, string>

export function FilesPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active: activeSigner, evm: evmSigner } = useSigner()
  const [manifests, setManifests] = useState<Manifest[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [registryRecords, setRegistryRecords] = useState<RegistryRecord[]>([])
  const [rowBusy, setRowBusy] = useState<RowBusy>({})
  const [syncing, setSyncing] = useState<Set<string>>(new Set()) // rootCids with a sync in flight (explicit state, never matched by copy)
  const [notice, setNotice] = useState<string | null>(null)
  const [recoverState, setRecoverState] = useState<string | null>(null)
  const [recoverBusy, setRecoverBusy] = useState(false)
  // passphrase fallback dialog for download decryption (suspends the decrypt promise)
  const [passPrompt, setPassPrompt] = useState<{ resolve: (v: string | null) => void } | null>(null)
  // publish results pending verification (R02: rescan by hash on unknown
  // results — never auto-resend)
  const [pendingPublish, setPendingPublish] = useState<PublishTaskRecord[]>([])
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  // three-state sharing: per-file on-chain derived badges + the share panel anchor
  const [shareInfos, setShareInfos] = useState<Map<string, ShareInfo>>(new Map())
  const [sharePanelRoot, setSharePanelRoot] = useState<string | null>(null)
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

  // three-state share badges (derived on-chain: Published event / listing;
  // failures render as unshared)
  const refreshShare = useCallback(async () => {
    const next = new Map<string, ShareInfo>()
    for (const m of manifests) {
      next.set(
        m.rootCid,
        await deriveShareInfo(m, {
          owner: evmSigner?.address ?? null,
          registryRecord: registryRecords.find((r) => r.rootCid === m.rootCid) ?? null,
        }),
      )
    }
    setShareInfos(next)
  }, [manifests, registryRecords, evmSigner])

  useEffect(() => {
    void refreshShare()
  }, [refreshShare])

  const verifyPending = async (record: PublishTaskRecord) => {
    setVerifyingId(record.id)
    try {
      const api = await connect()
      // verifyPublishTask internally: coverage verification (F02) + the manifest
      // persisted in the same transaction that deletes the task (F03)
      const manifest = await verifyPublishTask(api, record)
      if (manifest) {
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

  // Passphrase fallback dialog for download decryption: promise-based, the decrypt flow awaits it; cancel resolves null
  const openPassphrasePrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      setPassPrompt({ resolve })
    })

  const download = async (manifest: Manifest) => {
    setNotice(null)
    setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.retrieving') }))
    try {
      const api = await connect()
      const result = await retrieveFile(api, manifest)
      // R09: verify before saving — a failed integrity check blocks the save by
      // default; a forensic export requires explicit confirmation
      const exportUnverified = (bytes: Uint8Array, what: string): void => {
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.integrityBlock', [what]) }))
        if (window.confirm(t('files.exportUnverifiedConfirm'))) saveBlob(bytes, manifest.file.name, manifest.file.mimeType)
      }
      if (manifest.encryption) {
        // v2 encrypted file: verify ciphertext integrity first (retrieve checks
        // cipherSha256/cipherSize), then decrypt and check the plaintext sha256
        // (manifest.file.sha256)
        if (!result.sha256Match) throw new Error(t('files.cipherIntegrityFail'))
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.decrypting') }))
        const signMessage = evmSigner ? (msg: string) => signEvmMessage(evmSigner, msg) : null
        const plain = await decryptFileBytes(result.bytes, manifest.encryption, signMessage, openPassphrasePrompt)
        const plainSha = await sha256Hex(plain)
        if (plainSha !== manifest.file.sha256 || plain.length !== manifest.file.size) {
          exportUnverified(plain, `sha256 ${plainSha.slice(0, 16)}…`)
          return
        }
        saveBlob(plain, manifest.file.name, manifest.file.mimeType)
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.sha256Match', [plainSha.slice(0, 16)]) }))
        return
      }
      if (!result.sha256Match || result.bytes.length !== manifest.file.size) {
        exportUnverified(result.bytes, result.sha256Match ? 'length' : `sha256 ${result.sha256.slice(0, 16)}…`)
        return
      }
      saveBlob(result.bytes, manifest.file.name, manifest.file.mimeType)
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.sha256Match', [result.sha256.slice(0, 16)]) }))
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
      // share-panel meta sidecar: sharing stays usable even when the Registry
      // registration fails
      void putManifestPublishMeta(manifest.rootCid, {
        manifestCid: publication.manifestCid,
        height: publication.height,
        txHash: publication.txHash,
      })
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
      <UploadCard
        onPick={() => setNotice(null)}
        onPublished={(manifest) => {
          setNotice(t('files.publishedNotice', [manifest.txs[0].height, manifest.txs[0].txHash.slice(0, 18) + '…']))
          void watchArchive(manifest)
          void refresh()
        }}
        onError={() => void refreshPendingPublish()}
      />

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
        <PendingPublishNotice
          records={pendingPublish}
          verifyingId={verifyingId}
          onVerify={(p) => void verifyPending(p)}
          onDismiss={(p) => void dismissPending(p)}
        />
        {notice && <div className="notice">{notice}</div>}
        {recoverState && <div className="notice">{recoverState}</div>}
        <FilesTable
          manifests={manifests}
          taskByRoot={taskByRoot}
          rowBusy={rowBusy}
          syncedRootCids={syncedRootCids}
          syncing={syncing}
          shareInfoByRoot={shareInfos}
          sharePanelRoot={sharePanelRoot}
          onDownload={(m) => void download(m)}
          onExport={exportManifest}
          onSync={(m) => void syncToRegistry(m)}
          onDelete={(m) => void removeManifest(m)}
          onShare={(m) => setSharePanelRoot((cur) => (cur === m.rootCid ? null : m.rootCid))}
        />
        <p className="privacy-note">
          {t('files.privacyRegistry')}
          <Hint>{t('files.hintRegistry')}</Hint>
        </p>
      </section>

      {/* per-file share panel: three-state actions (list/delist/make public/
          copy link/deliver). SalesSection is dissolved — seller actions live
          here, buyer actions live in the Share tab. */}
      {sharePanelRoot &&
        (() => {
          const manifest = manifests.find((m) => m.rootCid === sharePanelRoot)
          if (!manifest) return null
          return (
            <SharePanel
              manifest={manifest}
              registryRecord={registryRecords.find((r) => r.rootCid === sharePanelRoot) ?? null}
              getPassphrase={openPassphrasePrompt}
              onNotice={setNotice}
              onChanged={() => {
                void refresh()
                void refreshShare()
              }}
            />
          )
        })()}

      {passPrompt && <PassphrasePrompt prompt={passPrompt} onResolve={(v) => { passPrompt.resolve(v); setPassPrompt(null) }} />}
    </div>
  )
}
