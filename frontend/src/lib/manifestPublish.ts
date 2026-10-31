// Re-publishing the manifest into the DSN: the manifest v1 is serialized as a
// file named `${rootCid}.manifest.json` (fixed name → content-addressed
// determinism: repacking the same manifest on any device yields the same CID),
// pushed through the shared publish pipeline (one-node remark) into a block, and
// the returned location info is used for the FileRegistry registration.
//
// The returned outerManifest is not stored or exported — it is only the
// receipt of this publication; the recovery side only needs manifestCid +
// height to restore the manifest itself from the chain (see manifestRecover.ts).

import type { ApiPromise } from '@polkadot/api'
import { publishPrepared, prepareUpload } from './publish'
import type { Manifest } from './manifest'
import type { SubstrateSigner } from './wallet/types'

export interface ManifestPublication {
  manifestCid: string // DAG root CID of the manifest file (the value registered in the Registry)
  height: number // block containing the manifest file's remark (the Registry's location hint)
  txHash: string
}

export const manifestFileName = (manifest: Manifest): string => `${manifest.rootCid}.manifest.json`

export async function publishManifestToChain(
  api: ApiPromise,
  manifest: Manifest,
  signer: SubstrateSigner,
  onStage?: (stage: string, detail?: string) => void,
): Promise<ManifestPublication> {
  const json = JSON.stringify(manifest)
  const file = new File([json], manifestFileName(manifest), { type: 'application/json' })
  // the stage argument is a stable identifier (not copy); the UI maps it to
  // progress text in the active locale
  onStage?.('packing-manifest')
  const prepared = await prepareUpload(file)
  // persist:false — the manifest file's own manifest does not enter the file
  // list (${rootCid}.manifest.json is only the locator for the registry entry);
  // the task is persisted as usual and the verify path skips listing per
  // persistManifest
  const outer = await publishPrepared(api, prepared, signer, (stage, detail) => onStage?.(stage, detail), {}, { persist: false })
  return { manifestCid: outer.rootCid, height: outer.txs[0].height, txHash: outer.txs[0].txHash }
}
