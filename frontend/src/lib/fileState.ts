// FileState directory state layer (deployed 2026-11-03): Registry v2 handles
// "registration + dev fee", this contract handles directory display state —
// the hide mark (the on-chain carrier of Delete→Hide; recovery on a new device
// automatically lands the file in the hidden group) and a generic per-file
// property layer (bytes32 slots reserved for future capabilities such as diff
// and compression, avoiding another contract deployment). Gas-only writes, no
// fee; the namespace matches v2 (msg.sender = owner, key = keccak256(manifestCid)).
// An empty config.fileStateAddress means the feature is disabled.

import { keccak256, toHex } from 'viem'
import { loadConfig } from './config.ts'
import { autoEvmChain } from './evm.ts'
import { FILE_STATE_ABI } from './file-state-abi.ts'
import { accountOf, registryPublicClient, waitWritten, walletClientFor } from './registry.ts'
import { t } from '../i18n/core.ts'
import type { EvmSigner } from './wallet/types.ts'

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDR = /^0x0{40}$/

/** Whether the feature is enabled (config.fileStateAddress configured) — the UI hides the Hide entry accordingly */
export function fileStateEnabled(): boolean {
  const addr = loadConfig().fileStateAddress
  return ADDR_RE.test(addr) && !ZERO_ADDR.test(addr)
}

function fileStateAddress(): `0x${string}` {
  const addr = loadConfig().fileStateAddress
  if (!ADDR_RE.test(addr) || ZERO_ADDR.test(addr)) throw new Error(t('errors.fileStateNotConfigured'))
  return addr as `0x${string}`
}

/** Generic propKey convention = keccak256(readable name), same as the contract tests.
 *  Reserved keys: the diff / compression features write these slots directly when
 *  they ship (value semantics to be finalized then: diff.kind stores
 *  keccak('text-line'|'binary'), diff.base stores the base version CID's 32-byte
 *  blake3 digest, compression stores a parameter digest) */
export const FILE_STATE_PROPS = {
  diffKind: keccak256(toHex('prop.diff.kind')),
  diffBase: keccak256(toHex('prop.diff.base')),
  compression: keccak256(toHex('prop.compression')),
} as const

/** Write the hide mark (gas-only write, no fee; same-value replays are absorbed by the contract's idempotency) */
export async function setHiddenFile(signer: EvmSigner, manifestCid: string, hidden: boolean): Promise<string> {
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: fileStateAddress(),
    abi: FILE_STATE_ABI,
    functionName: 'setHidden',
    args: [manifestCid, hidden],
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  await waitWritten(hash)
  return hash
}

// Batch-read chunk size (calldata size guard): one view call per 200 CIDs
const FLAG_BATCH = 200

/** Batch query the hidden set: returns the set of hidden manifestCids (owner = caller's namespace) */
export async function fetchHiddenFlags(owner: string, manifestCids: string[]): Promise<Set<string>> {
  const client = registryPublicClient()
  const address = fileStateAddress()
  const hidden = new Set<string>()
  for (let i = 0; i < manifestCids.length; i += FLAG_BATCH) {
    const batch = manifestCids.slice(i, i + FLAG_BATCH)
    const flags = (await client.readContract({
      address,
      abi: FILE_STATE_ABI,
      functionName: 'hiddenFlags',
      args: [owner as `0x${string}`, batch],
    })) as boolean[]
    batch.forEach((cid, j) => {
      if (flags[j]) hidden.add(cid)
    })
  }
  return hidden
}

/** Write one generic property (value = 0x0 clears; same-value replays are absorbed by the contract's idempotency) */
export async function setFileProp(
  signer: EvmSigner,
  manifestCid: string,
  propKey: `0x${string}`,
  value: `0x${string}`,
): Promise<string> {
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: fileStateAddress(),
    abi: FILE_STATE_ABI,
    functionName: 'setProp',
    args: [manifestCid, propKey, value],
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  await waitWritten(hash)
  return hash
}

/** Batch-read multiple properties of one file; 0x0 (unset/cleared) maps to null */
export async function readFileProps(
  owner: string,
  manifestCid: string,
  propKeys: readonly `0x${string}`[],
): Promise<(string | null)[]> {
  const raw = (await registryPublicClient().readContract({
    address: fileStateAddress(),
    abi: FILE_STATE_ABI,
    functionName: 'props',
    args: [owner as `0x${string}`, manifestCid, [...propKeys]],
  })) as string[]
  return raw.map((v) => (/^0x0+$/.test(v) ? null : v))
}
