// Recover a manifest from an on-chain registry entry:
// The Registry only stores manifestCid + a height hint → scan system.remark
// block by block over [height, height+SCAN_BLOCKS] (extractRemarkNodes builds
// a CID table) → hit the manifest file's root node → assemble (single-node
// file) → JSON → validateManifest → Manifest.
// The indexer is not involved (object mappings carry no block number, so the
// height hint is the only fast way to locate the manifest).

import type { ApiPromise } from '@polkadot/api'
import { extractRemarkNodes } from './chain'
import { assemble } from './dag'
import { validateManifest, type Manifest } from './manifest'
import { t } from '../i18n/core.ts'

// The publisher records the inclusion block; +3 tolerates the extreme case of
// a reorg followed by resubmission
const SCAN_BLOCKS = 3

export async function recoverManifestFromHint(
  api: ApiPromise,
  manifestCid: string,
  heightHint: number,
): Promise<Manifest> {
  for (let h = heightHint; h <= heightHint + SCAN_BLOCKS; h++) {
    const bh = await api.rpc.chain.getBlockHash(h)
    if (bh.toHex() === '0x' + '0'.repeat(64)) continue // fork boundaries briefly return a zero hash
    const { found } = await extractRemarkNodes(api, bh.toHex())
    const nodeBytes = found.get(manifestCid)
    if (!nodeBytes) continue
    const { bytes } = assemble(manifestCid, () => nodeBytes)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    const err = validateManifest(parsed)
    if (err) throw new Error(t('errors.recoveredManifestInvalid', [err]))
    return parsed as Manifest
  }
  throw new Error(t('errors.manifestRootNotFound', [heightHint, heightHint + SCAN_BLOCKS, manifestCid]))
}
