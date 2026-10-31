// Public publisher (share design, 2026-10-31): "public" = selling the file to
// "the public" at the 1 wei dust price; the purchase and the Published event
// (carrying the file key K) complete atomically in one transaction. When
// config publicPublisherAddress is empty, both the public entry and the public
// log reads are disabled (paid sharing via DirectSales is unaffected).
//
// Reader trust domain: only events emitted by this configured address are
// trusted (eth_getLogs address filtering is free); event fields
// (plainSha256/plainSize/key) are publisher claims, not content authenticity —
// the caller must retrieve, decrypt and verify the plaintext before trusting
// them.
//
// Disclosure state machine: irreversibility happens at signature/broadcast
// time, not at inclusion time. disclosureAttempted is persisted BEFORE the
// signature reaches the wallet; after broadcast, any failure (revert/lost/
// replaced) shows "public (unconfirmed)" and never falls back to unshared;
// retrying means "finish publishing", not "become private again". Only
// "signature never happened" (prepare failure / user rejected the signature /
// offline validation) may restore the prior state. everSold/everDisclosed are
// local-only UI hints (meta), never on-chain omniscience — a fresh origin on a
// new device misses them by design.

import { fromHex, toHex } from './bytes.ts'
import { loadConfig } from './config.ts'
import { PUBLIC_PUBLISHER_ABI } from './public-publisher-abi.ts'
import { getMeta, putMeta } from './store.ts'
import { accountOf, registryPublicClient, walletClientFor } from './registry.ts'
import { autoEvmChain } from './evm.ts'
import { fileKeyOf, listingIdOf, salesActive, assertSalesActive } from './sales.ts'
import type { EvmSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

const addrOk = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)

/** PublicPublisher address; null when unconfigured (pre-deploy / not set in Settings) */
export const publicPublisherAddress = (): `0x${string}` | null => {
  const addr = loadConfig().publicPublisherAddress
  return addrOk(addr) ? (addr as `0x${string}`) : null
}

export const publicPublisherActive = (): boolean => publicPublisherAddress() !== null

/** Explicit error instead of a viem Invalid address */
export function assertPublicPublisherActive(): void {
  if (!publicPublisherActive()) throw new Error(t('errors.publicPublisherNotConfigured'))
}

// ---- Published event reads (exact per-file lookup by fileKey topic; <=10k segments) ----

import type { AbiEvent } from 'viem'

// The ABI is a frozen as const artifact — narrow the Published item to viem's AbiEvent
const PUBLISHED_EVENT = PUBLIC_PUBLISHER_ABI.find(
  (item) => item.type === 'event' && (item as { name?: string }).name === 'Published',
) as unknown as AbiEvent

/** Decoded Published event fields (publisher claims — the reader must verify) */
interface PublishedArgs {
  fileKey?: string
  seller?: string
  manifestCid?: string
  key?: string
  plainSha256?: string
  plainSize?: bigint
  manifestHeightHint?: bigint
}

export interface PublishedEvent {
  fileKey: string
  seller: string
  manifestCid: string
  /** 0x-prefixed 32-byte hex (the file key K — public files are not secrets) */
  key: string
  plainSha256: string
  plainSize: bigint
  manifestHeightHint: bigint
  txHash: string
  blockNumber: number
}

// Per-file lookups are high-frequency badge reads — TTL cache (hits don't
// re-query; failures are not cached)
const PUBLISHED_TTL_MS = 60_000
const publishedCache = new Map<string, { at: number; value: PublishedEvent | null }>()

export function invalidatePublishedCache(manifestCid?: string): void {
  if (manifestCid) publishedCache.delete(manifestCid)
  else publishedCache.clear()
}

/** Query the Published event for one file (fileKey topic, always filtered by
 *  the publisher address). With multiple events (idempotent re-publish) the
 *  latest wins. Returns null when unconfigured or on query failure (failure
 *  and "not public" both render as not-public — a broadcast disclosure is
 *  covered by the disclosureAttempted marker, not by event existence). */
export async function fetchPublishedByKey(manifestCid: string): Promise<PublishedEvent | null> {
  if (!publicPublisherActive() || !salesActive()) return null
  const hit = publishedCache.get(manifestCid)
  if (hit && Date.now() - hit.at < PUBLISHED_TTL_MS) return hit.value
  const fileKey = fileKeyOf(manifestCid)
  const client = registryPublicClient()
  const from = Math.max(1, loadConfig().publicPublisherDeployBlock || 1)
  const latest = Number(await client.getBlockNumber())
  let found: PublishedEvent | null = null
  for (let start = from; start <= latest; start += 10_000) {
    const logs = await client.getLogs({
      address: publicPublisherAddress()!,
      event: PUBLISHED_EVENT,
      args: { fileKey },
      fromBlock: BigInt(start),
      toBlock: BigInt(Math.min(start + 9_999, latest)),
    })
    for (const log of logs) {
      const a = log.args as PublishedArgs
      if (a?.fileKey == null || !a.seller || !a.manifestCid || !a.key || a.plainSha256 == null) continue
      found = {
        fileKey: a.fileKey,
        seller: a.seller.toLowerCase(),
        manifestCid: a.manifestCid,
        key: a.key,
        plainSha256: a.plainSha256,
        plainSize: a.plainSize ?? 0n,
        manifestHeightHint: a.manifestHeightHint ?? 0n,
        txHash: log.transactionHash ?? '',
        blockNumber: Number(log.blockNumber),
      }
    }
  }
  publishedCache.set(manifestCid, { at: Date.now(), value: found })
  return found
}

// ---- Public write ----

export interface PublishPublicParams {
  manifestCid: string
  /** the current 1 wei listing revision (read back after createRevisionSales(1 wei)) */
  expectedRevision: bigint
  /** the file key K (32 bytes) */
  keyBytes: Uint8Array
  plainSha256: string // plaintext sha256 hex (manifest.file.sha256, no 0x prefix)
  plainSize: number
  /** block containing the manifest remark (location hint; Registry entry.height wins) */
  manifestHeightHint: number
}

/** Publish = 1 wei dust-price sale + Published event (K goes public with it).
 *  Disclosure state machine: signing and broadcasting complete inside the
 *  wallet (writeContract), so there is no observable "signed but not yet
 *  broadcast" moment — the caller persists the disclosure marker BEFORE this
 *  call (handing the request to the wallet counts as a broadcast attempt);
 *  a rejected signature (nothing broadcast) is caught by the caller, which
 *  then clears the marker and keeps the prior state. */
export async function publishPublic(signer: EvmSigner, params: PublishPublicParams): Promise<`0x${string}`> {
  assertPublicPublisherActive()
  assertSalesActive()
  if (params.keyBytes.length !== 32) throw new Error(t('errors.badKeyLength'))
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: publicPublisherAddress()!,
    abi: PUBLIC_PUBLISHER_ABI,
    functionName: 'publish',
    args: [
      signer.address as `0x${string}`, // seller (msg.sender must be the seller)
      listingIdOf(signer.address, params.manifestCid),
      params.expectedRevision,
      params.manifestCid,
      toHex(params.keyBytes) as `0x${string}`, // bytes args need 0x-prefixed hex
      ('0x' + params.plainSha256.replace(/^0x/, '')) as `0x${string}`,
      BigInt(params.plainSize),
      BigInt(params.manifestHeightHint),
    ],
    value: 1n,
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
  invalidatePublishedCache(params.manifestCid)
  return hash
}

// ---- Disclosure state machine and local history markers (meta store, UI-only hints) ----

export const markDisclosureAttempted = (rootCid: string): Promise<void> => putMeta(`disclosureAttempted:${rootCid}`, Date.now())
export const hasDisclosureAttempted = (rootCid: string): Promise<boolean> => getMeta<number>(`disclosureAttempted:${rootCid}`).then((v) => v != null)
/** Clear only when "signature never happened" (user rejected, nothing
 *  broadcast) — once broadcast, never rolls back */
export const unmarkDisclosureAttempted = (rootCid: string): Promise<void> => putMeta(`disclosureAttempted:${rootCid}`, null)

export const markEverDisclosed = (rootCid: string): Promise<void> => putMeta(`everDisclosed:${rootCid}`, Date.now())
export const hasEverDisclosed = (rootCid: string): Promise<boolean> => getMeta<number>(`everDisclosed:${rootCid}`).then((v) => v != null)

export const markEverSold = (rootCid: string): Promise<void> => putMeta(`everSold:${rootCid}`, Date.now())
export const hasEverSold = (rootCid: string): Promise<boolean> => getMeta<number>(`everSold:${rootCid}`).then((v) => v != null)

/** keyBytes <-> hex (the deep link k parameter) */
export const keyHex = (keyBytes: Uint8Array): string => toHex(keyBytes)
export const keyBytesOf = (hex: string): Uint8Array => fromHex(hex)
