import { packFile } from './dag.ts'
import { sha256Hex } from './bytes.ts'
import { validateManifest, type Manifest, type ManifestTx } from './manifest.ts'
import type { PreparedUpload, PublishOverrides } from './publish.ts'

export const RECOVERY_FORMAT = 'pd-recovery-v1'
interface RecoveryEnvelope {
  format: typeof RECOVERY_FORMAT
  manifest: Omit<Manifest, 'txs' | 'recovery'>
}

/** The on-chain document contains no future transaction hash or block height. */
export async function prepareRecoveryManifest(
  content: PreparedUpload,
  overrides: PublishOverrides,
  network: string,
  uploader: string,
): Promise<PreparedUpload> {
  const envelope: RecoveryEnvelope = {
    format: RECOVERY_FORMAT,
    manifest: {
      version: 2,
      network: /mainnet/i.test(network) ? 'mainnet' : network,
      rootCid: content.rootCid,
      file: { ...content.file, ...overrides.file },
      encryption: overrides.encryption ?? null,
      compression: null,
      uploader: { address: uploader },
      nodes: content.nodes.map((n) => ({ cid: n.cid, blake3: n.blake3, bytes: n.bytes.length })),
      submittedAt: new Date().toISOString(),
    },
  }
  const file = new File([JSON.stringify(envelope)], `${content.rootCid}.recovery.json`, { type: 'application/json' })
  const packed = await packFile(file)
  return {
    rootCid: packed.rootCid,
    nodes: packed.nodes,
    totalBytes: packed.nodes.reduce((sum, n) => sum + n.bytes.length, 0),
    file: { name: file.name, size: file.size, sha256: await sha256Hex(await file.arrayBuffer()), mimeType: file.type },
  }
}

/** Resolve transaction locations from the containing batch, never from untrusted JSON. */
export function resolveRecoveryManifest(raw: unknown, manifestCid: string, inclusion: ManifestTx): Manifest {
  const envelope = raw as RecoveryEnvelope
  if (envelope?.format !== RECOVERY_FORMAT || !envelope.manifest || typeof envelope.manifest !== 'object') {
    throw new Error('Invalid recovery document')
  }
  const manifest: Manifest = {
    ...envelope.manifest,
    txs: [inclusion],
    recovery: { manifestCid },
  }
  const error = validateManifest(manifest)
  if (error) throw new Error(error)
  return manifest
}
