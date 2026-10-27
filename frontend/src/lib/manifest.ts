// manifest v1 — a self-contained, shareable retrieval unit.
// A manifest plus any standard node plus the indexer is enough to retrieve the
// file, with no dependency on the uploader's local state.
// invariant: encryption/compression are null (reserved for future use); nodes[].blake3
// is bare hex in indexer convention (no 0x prefix).

import { t } from '../i18n'

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

export interface ManifestV1 {
  version: 1
  network: string
  rootCid: string
  file: { name: string; size: number; sha256: string; mimeType: string | null }
  encryption: null
  compression: null
  uploader: { address: string } | null
  nodes: ManifestNode[]
  txs: ManifestTx[]
  submittedAt: string
}

const BLAKE3_HEX = /^[0-9a-f]{64}$/
const CID_LIKE = /^baf[a-z0-9]+$/

// Validate structure; returns null when valid, otherwise a human-readable reason
export function validateManifest(m: unknown): string | null {
  if (typeof m !== 'object' || m === null) return t('errors.manifestNotJson')
  const v = m as Record<string, unknown>
  if (v.version !== 1) return t('errors.manifestUnsupportedVersion', [String(v.version)])
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
  return null
}

// PoC (no version field) → v1: normalize the network name, drop embedded
// endpoints (they move into app config), fill in empty fields
export function migrateManifest(raw: unknown): ManifestV1 {
  if (typeof raw !== 'object' || raw === null) throw new Error(t('errors.manifestNotJson'))
  const v = raw as Record<string, unknown>
  if (v.version === 1) {
    const err = validateManifest(v)
    if (err) throw new Error(err)
    return v as unknown as ManifestV1
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
  const migrated: ManifestV1 = {
    version: 1,
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
