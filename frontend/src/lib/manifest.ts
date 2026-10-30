// manifest v2 — the self-contained, shareable retrieval unit. v2 enables the
// encryption field (the pdenc-v1 envelope description) while file.* stays
// plaintext metadata: filenames/sizes are public, content is confidential
// (the same privacy boundary as Notes). A manifest plus any standard node is
// enough to retrieve the file — no publisher state involved. nodes[].blake3
// is the indexer-format bare hex (no 0x prefix). v1 semantics (encryption
// always null) are a subset of v2; migrateManifest normalizes v0/v1 to v2.

import { t } from '../i18n/core.ts'
import type { WrappedKey } from './vaultCrypto.ts'

export interface ManifestTx {
  txHash: string
  blockHash: string
  height: number
}

export interface ManifestNode {
  cid: string
  blake3: string
  bytes: number
}

/**
 * v2 encryption block. The ciphertext = AES-256-GCM(K, iv, plaintext) is
 * packed into the standard DAG (retrieval pipeline untouched);
 * cipherSha256/cipherSize describe the ciphertext (verified before
 * decryption) while file.sha256 stays the PLAINTEXT sha256 (checked after
 * decryption). K wrap channels reuse the vault WrappedKey structure; the
 * signature message is scoped to files (file key wrap v1).
 */
export interface ManifestEncryption {
  scheme: 'pdenc-v1'
  /** data-ciphertext GCM IV (12B hex) */
  iv: string
  cipherSha256: string
  cipherSize: number
  wrappedKeys: WrappedKey[]
}

export interface Manifest {
  version: 1 | 2
  network: string
  rootCid: string
  file: { name: string; size: number; sha256: string; mimeType: string | null }
  encryption: ManifestEncryption | null
  compression: null
  uploader: { address: string } | null
  nodes: ManifestNode[]
  txs: ManifestTx[]
  submittedAt: string
}

const BLAKE3_HEX = /^[0-9a-f]{64}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]+$/
const CID_LIKE = /^baf[a-z0-9]+$/

function validateEncryption(e: unknown): string | null {
  const enc = e as Record<string, unknown>
  if (enc.scheme !== 'pdenc-v1') return t('errors.manifestEncryptionScheme', [String(enc.scheme)])
  if (typeof enc.iv !== 'string' || !HEX.test(enc.iv) || enc.iv.length !== 24) return t('errors.manifestEncryptionIv')
  if (typeof enc.cipherSha256 !== 'string' || !SHA256_HEX.test(enc.cipherSha256)) return t('errors.manifestEncryptionSha')
  if (typeof enc.cipherSize !== 'number' || !Number.isInteger(enc.cipherSize) || enc.cipherSize <= 12)
    return t('errors.manifestEncryptionSize')
  if (!Array.isArray(enc.wrappedKeys) || enc.wrappedKeys.length === 0) return t('errors.manifestEncryptionNoKeys')
  for (const w of enc.wrappedKeys) {
    const wrap = w as Record<string, unknown>
    const mode = wrap.mode
    if (mode !== 'signature-v1' && mode !== 'passphrase-v1') return t('errors.manifestEncryptionWrapMode', [String(mode)])
    if (typeof wrap.iv !== 'string' || !HEX.test(wrap.iv) || typeof wrap.ct !== 'string' || !HEX.test(wrap.ct))
      return t('errors.manifestEncryptionWrapFields')
    if (mode === 'signature-v1' && (typeof wrap.message !== 'string' || typeof wrap.salt !== 'string' || !HEX.test(wrap.salt)))
      return t('errors.manifestEncryptionWrapFields')
    if (mode === 'passphrase-v1') {
      const kdf = wrap.kdf as Record<string, unknown> | undefined
      if (!kdf || kdf.alg !== 'PBKDF2-SHA256' || typeof kdf.iterations !== 'number' || typeof kdf.salt !== 'string' || !HEX.test(kdf.salt))
        return t('errors.manifestEncryptionWrapFields')
    }
  }
  return null
}

// Structural validation; null means valid, otherwise a human-readable reason
export function validateManifest(m: unknown): string | null {
  if (typeof m !== 'object' || m === null) return t('errors.manifestNotJson')
  const v = m as Record<string, unknown>
  if (v.version !== 1 && v.version !== 2) return t('errors.manifestUnsupportedVersion', [String(v.version)])
  if (typeof v.network !== 'string') return t('errors.manifestMissingNetwork')
  if (typeof v.rootCid !== 'string' || !CID_LIKE.test(v.rootCid)) return t('errors.manifestInvalidRootCid', [String(v.rootCid)])
  const file = v.file as Record<string, unknown> | undefined
  if (!file || typeof file.name !== 'string' || typeof file.size !== 'number' || typeof file.sha256 !== 'string')
    return t('errors.manifestIncompleteFile')
  if (!Array.isArray(v.nodes) || v.nodes.length === 0) return t('errors.manifestNodesEmpty')
  for (const n of v.nodes as Record<string, unknown>[]) {
    if (typeof n.cid !== 'string' || !CID_LIKE.test(n.cid)) return t('errors.manifestInvalidNodeCid', [String(n.cid)])
    if (typeof n.blake3 !== 'string' || !BLAKE3_HEX.test(n.blake3)) return t('errors.manifestInvalidNodeBlake3', [String(n.blake3)])
    if (typeof n.bytes !== 'number') return t('errors.manifestInvalidNodeBytes')
  }
  if (!Array.isArray(v.txs) || v.txs.length === 0) return t('errors.manifestTxsEmpty')
  for (const tx of v.txs as Record<string, unknown>[]) {
    if (typeof tx.txHash !== 'string' || typeof tx.blockHash !== 'string' || typeof tx.height !== 'number')
      return t('errors.manifestIncompleteTx')
  }
  // v1: encryption is always null (the original invariant); v2: null or a full encryption block
  if (v.version === 1) {
    if (v.encryption !== null && v.encryption !== undefined) return t('errors.manifestV1Encrypted')
    return null
  }
  if (v.encryption !== null && v.encryption !== undefined) {
    const err = validateEncryption(v.encryption)
    if (err) return err
  }
  return null
}

// PoC (no version field) → v1 → v2: normalize the network name, drop embedded
// endpoints (they move into app config), fill in empty fields. A v1 manifest
// is bumped to v2 as-is (encryption stays null).
export function migrateManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null) throw new Error(t('errors.manifestNotJson'))
  const v = raw as Record<string, unknown>
  if (v.version === 1 || v.version === 2) {
    if (v.version === 1) v.version = 2 // v1 → v2: version bump only, encryption stays null
    const err = validateManifest(v)
    if (err) throw new Error(err)
    return v as unknown as Manifest
  }
  // PoC format: network: "Autonomys Mainnet", embedded rpc/indexer URLs
  const legacy = v as {
    network?: string
    rootCid?: string
    file?: { name: string; size: number; sha256: string }
    nodes?: { cid: string; blake3: string; bytes: number }[]
    txs?: { txHash: string; blockHash: string; height: number }[]
    submittedAt?: string
  }
  const migrated: Manifest = {
    version: 2,
    network: /mainnet/i.test(legacy.network ?? '') ? 'mainnet' : (legacy.network ?? 'mainnet'),
    rootCid: legacy.rootCid ?? '',
    file: {
      name: legacy.file?.name ?? 'unnamed',
      size: legacy.file?.size ?? 0,
      sha256: legacy.file?.sha256 ?? '',
      mimeType: null,
    },
    encryption: null,
    compression: null,
    uploader: null,
    nodes: (legacy.nodes ?? []).map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes })),
    txs: (legacy.txs ?? []).map((t) => ({ txHash: t.txHash, blockHash: t.blockHash, height: t.height })),
    submittedAt: legacy.submittedAt ?? new Date(0).toISOString(),
  }
  const err = validateManifest(migrated)
  if (err) throw new Error(t('errors.manifestMigrationFailed', [err]))
  return migrated
}
