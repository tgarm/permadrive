import { resumeRead } from '../lib/resumeRead'
import { useWalletStep } from './WalletStep'
import { FundingStatus } from './FundingStatus'
import { FirstUseGuide } from './FirstUseGuide'
// My Files: upload (pack → fee confirmation → sign → confirm → background
// archive watch), download/retrieval, manifest import/export. The manifest
// set lives in IndexedDB (rootCid key); archive (indexer mapping) progress is
// local task state, never part of the manifest.
// Row action "sync to the on-chain registry" (republish the manifest + the
// FileRegistry entry). The directory reconciles incrementally on wallet
// connect, and the "Refresh" button re-runs the same incremental
// reconciliation manually.
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
import { type Manifest } from '../lib/manifest'
import { retrieveFile } from '../lib/retrieve'
import { publishManifestToChain } from '../lib/manifestPublish'
import { recoverManifestFromHint } from '../lib/manifestRecover'
import { syncDirectoryFromRegistry, type DirectorySyncResult } from '../lib/directorySync'
import { fetchEntries, getEvmBalance, quoteRegisterFee, registryPublicClient, registerFile } from '../lib/registry'
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
import { getManifestPublishMeta, putManifestPublishMeta } from '../lib/manifestPublish'
import { useI18n } from '../i18n'

type RowBusy = Record<string, string>

export function FilesPage() {
  const { evm } = useSigner()
  const { t } = useI18n()
  return evm ? <ConnectedFilesPage key={evm.address.toLowerCase()} /> : <section className="card" data-testid="files-wallet-required"><p>{t('files.connectDirectory')}</p></section>
}

function ConnectedFilesPage() {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active: activeSigner, evm: evmSigner } = useSigner()
  const [verifiedRoots, setVerifiedRoots] = useState<Set<string>>(new Set())
  const [manifests, setManifests] = useState<Manifest[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [registryRecords, setRegistryRecords] = useState<RegistryRecord[]>([])
  // do not render the guide slot until the local cache read has settled
  // (prevents the guide from flashing for users whose files are already local)
  const [loaded, setLoaded] = useState(false)
  // directory reconciliation state: pending=true means something is still
  // unsettled (checking / failed / entries that failed to recover) — while
  // unsettled the page shows a waiting card and NEVER the first-use guide
  // (an unresolved check does not mean the account is new)
  const [dirCheck, setDirCheck] = useState<{ state: 'checking' | 'done'; pending: boolean }>({ state: 'checking', pending: true })
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
  const { runWalletAction, walletStep, updateWalletProgress } = useWalletStep()
  const [operationRoot, setOperationRoot] = useState<string | null>(null)
  const resuming = useRef(false)
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
        if (record.persistManifest === false && record.file.name.endsWith('.manifest.json')) {
          const rootCid = record.file.name.slice(0, -'.manifest.json'.length)
          await putManifestPublishMeta(rootCid, { manifestCid: manifest.rootCid, height: manifest.txs[0].height, txHash: manifest.txs[0].txHash })
        }
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
    void refresh()
      .then(async () => {
        // restart unfinished archive watches (they survive reload/close)
        const [ts, ms] = [await listTasks(), await listManifests()]
        for (const tk of ts.filter((x) => x.kind === 'archive-watch' && !x.done)) {
          const manifest = ms.find((m) => m.rootCid === tk.id) ?? (await getManifest(tk.id))
          if (manifest) void watchArchive(manifest)
          else await deleteTask(tk.id)
        }
        await refreshPendingPublish()
      })
      .finally(() => setLoaded(true))
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
        setVerifiedRoots((old) => new Set(old).add(manifest.rootCid))
        saveBlob(plain, manifest.file.name, manifest.file.mimeType)
        setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.sha256Match', [plainSha.slice(0, 16)]) }))
        return
      }
      if (!result.sha256Match || result.bytes.length !== manifest.file.size) {
        exportUnverified(result.bytes, result.sha256Match ? 'length' : `sha256 ${result.sha256.slice(0, 16)}…`)
        return
      }
      setVerifiedRoots((old) => new Set(old).add(manifest.rootCid))
      saveBlob(result.bytes, manifest.file.name, manifest.file.mimeType)
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.sha256Match', [result.sha256.slice(0, 16)]) }))
    } catch (e) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: `✗ ${(e as Error).message}` }))
    }
  }

  const syncedRootCids = new Set(registryRecords.map((r) => r.rootCid))

  const syncToRegistry = async (manifest: Manifest, fromResume = false) => {
    if (resuming.current) return
    setOperationRoot(manifest.rootCid)
    setNotice(null)
    if (!evmSigner) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.needEvm') }))
      return
    }
    const existing = registryRecords.find((r) => r.rootCid === manifest.rootCid && r.evmAddress.toLowerCase() === evmSigner.address.toLowerCase())
    if (existing) {
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.alreadyHosted', [existing.manifestCid.slice(0, 16), existing.height]) }))
      return
    }
    resuming.current = true
    setSyncing((s) => new Set(s).add(manifest.rootCid))
    const progress = (message: string) => setRowBusy((b) => ({ ...b, [manifest.rootCid]: message }))
    const read = <T,>(phase: string, action: () => Promise<T>) => resumeRead(phase, t(`resume.${phase}`), action, progress, t('resume.timeout'))
    try {
      const savedPublication = await read('local', () => getManifestPublishMeta(manifest.rootCid))
      if (savedPublication) {
        const entry = (await read('directory', () => fetchEntries(evmSigner.address))).find((e) => e.manifestCid === savedPublication.manifestCid)
        if (entry) {
          await putRegistryRecord({ rootCid: manifest.rootCid, manifestCid: entry.manifestCid, height: Number(entry.height), evmAddress: evmSigner.address, syncedAt: Date.now() })
          await refresh()
          setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.registeredAlready') }))
          return
        }
      }
      const fee = await read('fee', () => quoteRegisterFee(manifest.file.size))
      const gasReserve = 250_000n * await read('gas', () => registryPublicClient().getGasPrice())
      if (await read('balance', () => getEvmBalance(evmSigner.address)) < fee + gasReserve) throw new Error(t('funding.insufficientEvm'))
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('stage.packingManifest') }))
      const waiting = await read('pending', () => listPendingPublish())
      if (waiting.some((task) => task.file.name === `${manifest.rootCid}.manifest.json`)) {
        throw new Error(t('onboarding.resolveFirst'))
      }
      const publication = await (async () => {
        if (savedPublication) return savedPublication
        if (!activeSigner) throw new Error(t('files.needSubstrate'))
        const api = await read('consensus', () => connect())
        progress(t('resume.manifest'))
        return publishManifestToChain(api, manifest, activeSigner, (stage, detail) => {
          // manifest publication uses different progress copy than content upload (it emphasizes the manifest itself)
          const text = {
            'preparing-wallet': t('walletSteps.preparing'),
            signing: t('stage.manifestSigning'),
            submitting: t('stage.manifestSubmitting'),
            submitted: t('stage.submitted'),
            scanning: t('stage.manifestScanning'),
            confirming: t('stage.manifestConfirming'),
            'packing-manifest': t('stage.packingManifest'),
          }[stage] ?? stage
          updateWalletProgress(text)
          setRowBusy((b) => ({ ...b, [manifest.rootCid]: detail ? `${text} ${detail}` : text }))
        }, (submit) => runWalletAction(t('walletSteps.manifest'), t('walletSteps.manifestHelp'), submit))
      })()
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.manifestPublished', [publication.height]) }))
      // share-panel meta sidecar: sharing stays usable even when the Registry
      // registration fails
      await putManifestPublishMeta(manifest.rootCid, {
        manifestCid: publication.manifestCid,
        height: publication.height,
        txHash: publication.txHash,
      })
      // dev fee = max(minFee, 10% of the storage-fee estimate); quoted before payment
      const feeAi3 = (Number(fee) / 1e18).toFixed(4)
      setRowBusy((b) => ({ ...b, [manifest.rootCid]: t('files.registering', [feeAi3]) }))
      const register = () => registerFile(evmSigner, { manifestCid: publication.manifestCid, height: publication.height, name: manifest.file.name, size: manifest.file.size }, { fee })
      const reg = fromResume && savedPublication
        ? await register()
        : await runWalletAction(t('walletSteps.register'), `${t('walletSteps.registerHelp', [feeAi3, (Number(gasReserve) / 1e18).toFixed(6)])} ${t('onboarding.localRisk')}`, register)
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
      resuming.current = false
      setSyncing((s) => {
        const next = new Set(s)
        next.delete(manifest.rootCid)
        return next
      })
    }
  }

  // Directory reconciliation = read registry entries → incremental block scan to
  // restore manifests → store (the cross-device main path). Runs once
  // automatically on connect (auto=true: silent — the waiting card or the file
  // table is the feedback); the "Refresh" button (auto=false) runs the same
  // incremental reconciliation, it just says the outcome out loud. Neither
  // resurrects locally deleted files (to get them back: a new browser or a
  // cleared site reconnects and restores from the registry).
  // The whole flow is read-only chain access + local writes, no wallet prompts.
  const runDirectorySync = async (auto = false) => {
    if (!evmSigner || recoverBusy) return
    setRecoverBusy(true)
    setDirCheck({ state: 'checking', pending: true })
    setRecoverState(auto ? null : t('files.readingRegistry'))
    try {
      // lazy consensus connect: an empty-directory verdict must not require it
      // (the guide decision costs a single EVM view call)
      let api: Awaited<ReturnType<typeof connect>> | null = null
      const result: DirectorySyncResult = await syncDirectoryFromRegistry(
        {
          address: evmSigner.address,
          fetchEntries,
          listManifests,
          listRegistryRecords,
          putManifest,
          putRegistryRecord,
          recover: async (entry) => {
            api ??= await connect()
            return recoverManifestFromHint(api, entry.manifestCid, entry.height)
          },
        },
        ({ index, total, entry }) => {
          setRecoverState(t('files.recoveringItem', [index + 1, total, entry.name, entry.height]))
        },
      )
      setDirCheck({ state: 'done', pending: !result.empty && result.failed.length > 0 })
      await refresh()
      // summary: in auto mode an empty directory / nothing new stays silent (the
      // waiting card or the file table is the feedback); an explicit "Refresh"
      // says the outcome out loud. Failed entries are listed by name; a retry
      // only re-processes them.
      if (result.empty) {
        setRecoverState(auto ? null : t('files.registryEmpty', [evmSigner.address.slice(0, 10) + '…']))
        return
      }
      const names = result.failed.map((f) => f.name).join(', ')
      const newFiles = t(result.recovered === 1 ? 'files.oneNewFile' : 'files.nNewFiles', [result.recovered])
      const suffix = result.skipped > 0 ? t('files.skippedSuffix', [result.skipped]) : ''
      if (result.failed.length > 0) {
        setRecoverState(
          result.recovered > 0
            ? t('files.recoverPartial', [newFiles + suffix, result.failed.length, names])
            : t('files.recoverAllFailed', [result.failed.length, names]),
        )
      } else if (result.recovered > 0 || !auto) {
        setRecoverState(t('files.recoverDone', [newFiles, suffix, result.total]))
      } else {
        setRecoverState(null)
      }
    } catch (e) {
      setDirCheck({ state: 'done', pending: true })
      setRecoverState(`✗ ${(e as Error).message}`)
    } finally {
      setRecoverBusy(false)
    }
  }

  // auto directory reconciliation once per mount (ConnectedFilesPage remounts
  // per address, so switching accounts re-runs it naturally)
  const autoSyncStarted = useRef(false)
  useEffect(() => {
    if (autoSyncStarted.current) return
    autoSyncStarted.current = true
    void runDirectorySync(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeManifest = async (manifest: Manifest) => {
    if (!window.confirm(t('files.deleteConfirm', [manifest.file.name]))) return
    await deleteManifest(manifest.rootCid)
    await deleteTask(manifest.rootCid)
    await refresh()
  }

  const taskByRoot = new Map(tasks.map((tk) => [tk.id, tk]))
  const guideManifest = manifests.find((m) => m.rootCid === operationRoot) ?? manifests[0]
  const unfinishedManifests = manifests.filter((m) => !syncedRootCids.has(m.rootCid))
  const hasUnregisteredFiles = unfinishedManifests.length > 0
  // guide slot, three states: while the local library is empty and the
  // directory check/recovery is unsettled, show a waiting card; the first-use
  // guide only appears once the outcome is settled with nothing pending (the
  // directory is empty, or every entry is already reconciled)
  const dirSettledClean = dirCheck.state === 'done' && !dirCheck.pending
  const showDirectoryCheck = loaded && manifests.length === 0 && !dirSettledClean
  const showFirstUseGuide = loaded && manifests.length === 0 && dirSettledClean

  return (
    <div className="page">
      {showDirectoryCheck && (
        <section className="card" data-testid="directory-check" aria-busy={dirCheck.state !== 'done'}>
          <p role="status">{recoverState ?? t('files.checkingDirectory')}</p>
          {dirCheck.state === 'done' && (
            <div className="row">
              <button className="btn small" disabled={recoverBusy} onClick={() => void runDirectorySync(true)}>
                {t('files.checkRetry')}
              </button>
            </div>
          )}
        </section>
      )}
      {showFirstUseGuide && <FirstUseGuide
        keyPrepared={!!guideManifest?.encryption}
        recoveryConnected={!!evmSigner}
        fileName={guideManifest?.file.name ?? null}
        backedUp={!!guideManifest && syncedRootCids.has(guideManifest.rootCid)}
        verified={!!guideManifest && verifiedRoots.has(guideManifest.rootCid)}
        onUpload={() => document.getElementById('first-upload')?.scrollIntoView({ behavior: 'smooth' })}
        busy={!!guideManifest && syncing.has(guideManifest.rootCid)}
        onVerify={() => { if (guideManifest) void download(guideManifest) }}
      />}
      <div id="first-upload" />
      <UploadCard
        runWalletAction={runWalletAction}
        onWalletProgress={updateWalletProgress}
        onPick={() => { setNotice(null); setOperationRoot(null) }}
        onPublished={(manifest) => {
          setNotice(null)
          void watchArchive(manifest)
          void refresh()
          void syncToRegistry(manifest)
        }}
        onError={() => void refreshPendingPublish()}
      />

      <section className="card">
        <div className="card-head">
          <h2>{t('files.myFiles')}</h2>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => void runDirectorySync(false)} disabled={recoverBusy}>
              {t('files.refresh')}
            </button>
          </div>
        </div>
        <div className="file-operation" data-testid="file-operation">
          {evmSigner && manifests.length > 0 && <label className="row">
            {t('funding.file')}
            <select aria-label={t('funding.file')} value={operationRoot ?? ''} onChange={(e) => setOperationRoot(e.target.value || null)}>
              <option value="">{t('funding.chooseFile')}</option>
              {manifests.map((m) => <option key={m.rootCid} value={m.rootCid}>{m.file.name}</option>)}
            </select>
          </label>}
      {unfinishedManifests.length > 0 && (
        <section className="card" data-testid="unfinished-storage">
          <h3>{t('onboarding.unfinished')}</h3>
          <p>{t('onboarding.unfinishedHelp')}</p>
          <p className="warning" role="alert" data-testid="unfinished-storage-warning" hidden={!hasUnregisteredFiles}>{t('onboarding.localRisk')}</p>
        </section>
      )}
          {operationRoot && rowBusy[operationRoot] && (!syncedRootCids.has(operationRoot) || syncing.has(operationRoot)) && <p role="status" data-testid="save-progress">{rowBusy[operationRoot]}</p>}
          {walletStep}
          <FundingStatus manifest={manifests.find((m) => m.rootCid === operationRoot)} />
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
          registryRecords={registryRecords}
          rowBusy={rowBusy}
          syncedRootCids={syncedRootCids}
          syncing={syncing}
          canSync={!!evmSigner}
          shareInfoByRoot={shareInfos}
          sharePanelRoot={sharePanelRoot}
          onDownload={(m) => void download(m)}
          onSync={(m) => void syncToRegistry(m, true)}
          onDelete={(m) => void removeManifest(m)}
          onShare={(m) => setSharePanelRoot((cur) => (cur === m.rootCid ? null : m.rootCid))}
        />
        <div className="privacy-note">
          {t('files.privacyRegistry')}
          <Hint>{t('files.hintRegistry')}</Hint>
        </div>
      </section>

      {/* per-file share panel: three-state actions (list/delist/make public/
          copy link/deliver). SalesSection is dissolved — seller actions live
          here, buyer actions live in the Share tab. */}
      {sharePanelRoot &&
        (() => {
          const manifest = manifests.find((m) => m.rootCid === sharePanelRoot)
          if (!manifest || !shareInfos.has(manifest.rootCid)) return null
          return (
            <SharePanel
              initialShareInfo={shareInfos.get(manifest.rootCid)}
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
