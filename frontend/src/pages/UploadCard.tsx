// Upload card: drop/choose → pack (optional encryption: K + AES-GCM → the
// ciphertext packed into the standard DAG) → fee confirmation panel (with the
// passphrase-channel input) → sign → submit → confirm. The publish pipeline
// lives in lib/publish (batch-first; the manifest and the task deletion are
// persisted in one transaction, F03). Success/failure is reported back to
// FilesPage via callbacks: notice, archive watch (indexer), pending-publish
// task refresh.

import { useRef, useState } from 'react'
import { useChain } from '../chain-context'
import { useSigner } from '../signer-context'
import { Hint } from '../components/Hint'
import { ChainTag } from '../components/ChainTag'
import { formatBytes, sha256Hex } from '../lib/bytes'
import { estimateFee, prepareUpload, publishPrepared, type PreparedUpload, type PublishOverrides, type PublishStage } from '../lib/publish'
import { signEvmMessage } from '../lib/vault'
import {
  addPassphraseChannel,
  addSignatureChannel,
  requireChannel,
  startEncryption,
  type EncryptSession,
} from '../lib/fileCrypto'
import type { Manifest } from '../lib/manifest'
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

export function UploadCard({
  onPick,
  onPublished,
  onError,
}: {
  /** picking a new file clears the page notice (same behavior as before the split) */
  onPick: () => void
  onPublished: (manifest: Manifest) => void
  onError: () => void
}) {
  const { t } = useI18n()
  const { connect } = useChain()
  const { active: activeSigner, evm: evmSigner } = useSigner()
  const [upload, setUpload] = useState<UploadSession | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [encryptOn, setEncryptOn] = useState(false)
  const [uploadPassphrase, setUploadPassphrase] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pickFile = async (file: File) => {
    onPick()
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
      // publishPrepared already persisted the manifest in the same transaction
      // that deleted the task (F03)
      setUpload(null)
      setUploadPassphrase('')
      onPublished(manifest)
    } catch (e) {
      setUpload((cur) => (cur ? { ...cur, stage: 'error', error: (e as Error).message } : cur))
      onError() // a publish task may have been persisted (pending verification)
    }
  }

  return (
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
                <span>
                  <ChainTag chain="consensus" /> {t('files.feeEstimate')}
                </span>
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
