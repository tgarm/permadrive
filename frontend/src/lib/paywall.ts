// Paid downloads: Paywall escrow state-machine interaction + the key-delivery
// protocol. key = keccak256(manifestCid) (the same digest the registry uses
// for its manifestCidKey). On-chain data is public, so the file key K is
// delivered as ciphertext over the mailbox: buyer purchases → the seller
// verifies the on-chain deal is Escrowed → unwraps K, boxes it to the buyer's
// announced encryption pubkey, sends a pdgrant message → markDelivered → the
// buyer confirms receipt (or refunds within the grace period). No keeper:
// every state transition is triggered by an interested party. Digital-goods
// mode (buying grants the file, no DRM) is stated in the UI.
//
// R05: pdgrant v2 binds the order identity (chainId/paywall/orderId/buyer/
// seller) — the buyer verifies the message comes from the order's seller, is
// addressed to them and matches the order, so a wrong/forged candidate cannot
// shadow the correct delivery. v1 (no binding fields) still parses, for legacy
// orders only.
//
// Dual-instance strategy (R01 deployment handling + second review F01):
// the v1 Paywall carries a seller-overwrite flaw and is frozen read-only —
// new purchases/listings/deliveries are rejected at the WRITE LAYER (even
// while v2 is undeployed, so the flawed contract cannot absorb new orders);
// v1 keeps refund/confirm/withdraw entries for existing-order disposition
// only (confirm additionally verifies the current payee, see
// assertLegacyPayee). While v2 is unconfigured, paid downloads are entirely
// unavailable — that is the intended state until PaywallV2 is deployed. The
// v2 order model:
// Order snapshots seller/price/feeBps (delist/reprice never affect escrowed
// orders), independent increasing orderIds (repurchase history preserved),
// and purchase names the seller plus a maxPrice bound.

import { keccak256, parseAbiItem, toHex } from 'viem'
import { loadConfig } from './config'
import { PAYWALL_ABI } from './paywall-abi'
import { PAYWALL_V2_ABI } from './paywall-abi-v2'
import { getMeta, putMeta } from './store.ts'
import { accountOf, fetchEntries, registryPublicClient, walletClientFor, type RegistryEntry } from './registry'
import { autoEvmChain } from './evm'
import { fromHex } from './bytes.ts'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, parseEnvelope as parseBoxEnvelope, publicKeyFromBase64 } from './boxCrypto.ts'
import { getAnnouncedKey, localBoxSecretKey, sendEncryptedMessage } from './mailbox'
import { tryUnwrapWithSignature, unwrapWithPassphrase } from './vaultCrypto.ts'
import type { Manifest } from './manifest'
import type { EvmSigner } from './wallet/types'
import { t } from '../i18n/core.ts'

const addrOk = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)

/** v1 (legacy) instance: carries the overwrite-seller flaw, frozen read-only — refund/confirm/withdraw still work */
export const paywallAddress = (): `0x${string}` => {
  const addr = loadConfig().paywallAddress
  if (!addrOk(addr)) throw new Error(t('errors.paywallNotConfigured'))
  return addr as `0x${string}`
}

/** v2 instance address; null while unconfigured (before deployment / not set in Settings) */
export const paywallV2Address = (): `0x${string}` | null => {
  const addr = loadConfig().paywallV2Address
  return addrOk(addr) ? (addr as `0x${string}`) : null
}

/** whether v2 is the active instance (new listings/purchases/deliveries all go through v2) */
export const paywallV2Active = (): boolean => paywallV2Address() !== null

/** key = keccak256(manifestCid) (registry manifestCidKey, same derivation) */
export const listingKey = (manifestCid: string): `0x${string}` => keccak256(toHex(manifestCid))

export interface Listing {
  seller: string
  price: bigint // 0 = not listed
}

export async function getListing(manifestCid: string): Promise<Listing | null> {
  const raw = await registryPublicClient().readContract({
    address: paywallAddress(),
    abi: PAYWALL_ABI,
    functionName: 'listings',
    args: [listingKey(manifestCid)],
  })
  // public mapping getter returns an unnamed tuple (solc does not name the components)
  const [seller, price] = raw as unknown as [string, bigint]
  return seller === '0x0000000000000000000000000000000000000000' ? null : { seller, price }
}

export interface DealView {
  buyer: string
  price: bigint
  state: number // 0 None / 1 Escrowed / 2 Delivered / 3 Released / 4 Refunded
  purchasedAt: bigint
  deliveredAt: bigint
}

export async function getDeal(manifestCid: string, buyer: string): Promise<DealView | null> {
  const raw = await registryPublicClient().readContract({
    address: paywallAddress(),
    abi: PAYWALL_ABI,
    functionName: 'deal',
    args: [listingKey(manifestCid), buyer as `0x${string}`],
  })
  const d = raw as unknown as DealView
  return d.state === 0 ? null : d
}

export const DEAL_STATE = ['none', 'escrowed', 'delivered', 'released', 'refunded'] as const

/** write ops use literal functionName/args (viem writeContract generics derive from the ABI) */
async function paywallWrite(op: Promise<`0x${string}`>): Promise<`0x${string}`> {
  const hash = await op
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
  return hash
}

// F01 (second design review): the legacy freeze does not stop at copy — the
// write layer rejects too. purchase/setPrice/markDelivered create new orders
// or new escrows, where the R01 flaw still applies; refund/confirm/withdraw
// are existing-fund disposition and stay open (confirm additionally verifies
// the payee, see assertLegacyPayee). The UI hides the entries too — this is
// the second gate.
export function assertPaywallV2Active(): void {
  if (!paywallV2Active()) throw new Error(t('errors.paywallLegacyFrozen'))
}

/**
 * F01: a legacy order's "confirm receipt" settles to the CURRENT listing on
 * the v1 contract — the listing can be overwritten by anyone, so the current
 * payee must be verified to still be the order's seller before confirming.
 * Skipped when the seller is unknown (e.g. delisted after purchase): the
 * deal's price was snapshotted and funds flow to listing.seller — the UI says
 * so.
 */
export async function assertLegacyPayee(manifestCid: string | null, expectedSeller: string): Promise<void> {
  if (!manifestCid || !expectedSeller) return
  const listing = await getListing(manifestCid)
  if (listing && listing.seller.toLowerCase() !== expectedSeller.toLowerCase()) {
    throw new Error(t('errors.paywallPayeeMismatch'))
  }
}

const writeOps = (signer: EvmSigner) => {
  const wallet = walletClientFor(signer)
  const account = accountOf(signer)
  const base = { address: paywallAddress(), abi: PAYWALL_ABI, chain: autoEvmChain, account } as const
  return {
    // setPrice/purchase/markDelivered are kept for type completeness only —
    // the three exported wrappers hit the F01 guard first, which always
    // throws, so these constructors never execute
    setPrice: (key: `0x${string}`, price: bigint) =>
      wallet.writeContract({ ...base, functionName: 'setPrice', args: [key, price] }),
    purchase: (key: `0x${string}`, price: bigint) =>
      wallet.writeContract({ ...base, functionName: 'purchase', args: [key], value: price }),
    markDelivered: (key: `0x${string}`, buyer: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'markDelivered', args: [key, buyer] }),
    // existing-order disposition entries only
    confirmReceipt: (key: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'confirmReceipt', args: [key] }),
    refund: (key: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'refund', args: [key] }),
    release: (key: `0x${string}`, buyer: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'release', args: [key, buyer] }),
    withdraw: () =>
      wallet.writeContract({ ...base, functionName: 'withdraw', args: [] }),
  }
}

// F01: the three legacy writes below are always rejected (regardless of whether
// v2 is deployed — the v1 freeze is absolute; the R01 flaw does not disappear
// because v2 exists). The UI removed the entries too; the guard throws
// synchronously so writeContract is never reached.
export const setListingPrice = (signer: EvmSigner, manifestCid: string, priceWei: bigint): Promise<`0x${string}`> => {
  assertPaywallV2Active() // always throws: legacy setPrice is frozen
  return paywallWrite(writeOps(signer).setPrice(listingKey(manifestCid), priceWei))
}

export const purchase = (signer: EvmSigner, manifestCid: string, priceWei: bigint): Promise<`0x${string}`> => {
  assertPaywallV2Active() // always throws: legacy purchase is frozen
  return paywallWrite(writeOps(signer).purchase(listingKey(manifestCid), priceWei))
}

export const markDelivered = (signer: EvmSigner, manifestCid: string, buyer: string): Promise<`0x${string}`> => {
  assertPaywallV2Active() // always throws: legacy markDelivered is frozen
  return paywallWrite(writeOps(signer).markDelivered(listingKey(manifestCid), buyer as `0x${string}`))
}

export const confirmReceipt = (signer: EvmSigner, manifestCid: string) =>
  paywallWrite(writeOps(signer).confirmReceipt(listingKey(manifestCid)))

export const refundDeal = (signer: EvmSigner, manifestCid: string) =>
  paywallWrite(writeOps(signer).refund(listingKey(manifestCid)))

/** legacy key-based direct ops: after the seller delists, manifestCid cannot be
 * recovered from the key, while refund/confirm on the v1 contract only need
 * key+buyer — keep the entries working */
export const confirmReceiptByKey = (signer: EvmSigner, key: `0x${string}`) =>
  paywallWrite(writeOps(signer).confirmReceipt(key))

export const refundByKey = (signer: EvmSigner, key: `0x${string}`) =>
  paywallWrite(writeOps(signer).refund(key))

export const releaseDeal = (signer: EvmSigner, manifestCid: string, buyer: string) =>
  paywallWrite(writeOps(signer).release(listingKey(manifestCid), buyer as `0x${string}`))

export async function getCredits(address: string): Promise<bigint> {
  return registryPublicClient().readContract({
    address: paywallAddress(),
    abi: PAYWALL_ABI,
    functionName: 'credits',
    args: [address as `0x${string}`],
  })
}

export const withdrawCredits = (signer: EvmSigner) => paywallWrite(writeOps(signer).withdraw())

// ---- purchase event scan (shared by buyer "my purchases" and seller "pending authorizations") ----

const PURCHASED = parseAbiItem('event Purchased(bytes32 indexed key, address indexed buyer, uint96 price)')

export interface PurchaseLog {
  key: string
  buyer: string
  price: bigint
  txHash: string
  blockNumber: number
}

// RPC hard limit: eth_getLogs range ≤ 10000 blocks (observed error)
async function fetchPurchasedLogs(fromBlock: number): Promise<PurchaseLog[]> {
  const latest = Number(await registryPublicClient().getBlockNumber())
  const out: PurchaseLog[] = []
  for (let start = fromBlock; start <= latest; start += 10_000) {
    const logs = await registryPublicClient().getLogs({
      address: paywallAddress(),
      event: PURCHASED,
      fromBlock: BigInt(start),
      toBlock: BigInt(Math.min(start + 9_999, latest)),
    })
    for (const log of logs) {
      const a = log.args
      if (!a?.key || !a.buyer || a.price == null) continue
      out.push({ key: a.key, buyer: a.buyer.toLowerCase(), price: a.price, txHash: log.transactionHash, blockNumber: Number(log.blockNumber) })
    }
  }
  return out
}

// seller → registry entries cache (to map a listing key back to a directory entry;
// entries carry height for manifest recovery)
// TTL'd (directories can grow) and network failures are never cached as empty
// successes — the next call retries
const ENTRY_TTL_MS = 60_000
const entriesCache = new Map<string, { at: number; entries: Awaited<ReturnType<typeof fetchEntries>> }>()

export function invalidateEntriesCache(seller?: string): void {
  if (seller) entriesCache.delete(seller.toLowerCase())
  else entriesCache.clear()
}

async function entryByKey(seller: string, key: string): Promise<RegistryEntry | null> {
  const cacheKey = seller.toLowerCase()
  const hit = entriesCache.get(cacheKey)
  let entries: Awaited<ReturnType<typeof fetchEntries>>
  if (hit && Date.now() - hit.at < ENTRY_TTL_MS) {
    entries = hit.entries
  } else {
    try {
      entries = await fetchEntries(seller)
    } catch {
      return null // don't cache failures — retry on the next call
    }
    entriesCache.set(cacheKey, { at: Date.now(), entries })
  }
  for (const e of entries) if (listingKey(e.manifestCid) === key) return e
  return null
}

/** normalized UI row shared by legacy and v2 orders (the component never derives
 * seller/state from the current listing) */
export interface OrderRow {
  contract: 'v2' | 'legacy'
  orderId: bigint | null // v2; null for legacy (the v1 contract has no order ids)
  key: string
  price: bigint
  state: number // 0 None / 1 Escrowed / 2 Delivered / 3 Released / 4 Refunded (same order in both contracts)
  seller: string // '' when it cannot be recovered (legacy delisted; refund/confirm still work)
  buyer: string
  entry: RegistryEntry | null
}

/** seller pending authorizations (legacy): Purchased ∩ own directory keys, deal still Escrowed */
export async function fetchPendingGrants(seller: string): Promise<OrderRow[]> {
  const myKeys = new Set((await fetchEntries(seller)).map((e) => listingKey(e.manifestCid)))
  if (myKeys.size === 0) return []
  const logs = await fetchPurchasedLogs(loadConfig().paywallDeployBlock)
  const pending: OrderRow[] = []
  for (const log of logs) {
    if (!myKeys.has(log.key as `0x${string}`)) continue
    const deal = await dealOfKey(log.key, log.buyer)
    if (deal && deal.state === 1) {
      const entry = await entryByKey(seller, log.key)
      pending.push({ contract: 'legacy', orderId: null, key: log.key, price: log.price, state: deal.state, seller, buyer: log.buyer, entry })
    }
  }
  return pending
}

/** buyer purchase records (legacy): Purchased (buyer=me) → current Deal state.
 * A missing listing (seller delisted) no longer drops the order — refund/confirm
 * stay usable, only the manifest lookup (entry) is unavailable. */
export async function fetchMyPurchases(me: string): Promise<OrderRow[]> {
  const logs = await fetchPurchasedLogs(loadConfig().paywallDeployBlock)
  const mine = logs.filter((l) => l.buyer === me.toLowerCase())
  const out: OrderRow[] = []
  for (const log of mine) {
    const deal = await dealOfKey(log.key, me)
    if (!deal) continue
    const listing = await listingOfKey(log.key)
    const seller = listing?.seller ?? ''
    const entry = listing ? await entryByKey(listing.seller, log.key) : null
    out.push({ contract: 'legacy', orderId: null, key: log.key, price: deal.price, state: deal.state, seller, buyer: me.toLowerCase(), entry })
  }
  return out
}

async function listingOfKey(key: string): Promise<Listing | null> {
  const raw = await registryPublicClient().readContract({ address: paywallAddress(), abi: PAYWALL_ABI, functionName: 'listings', args: [key as `0x${string}`] })
  const [seller, price] = raw as unknown as [string, bigint]
  return seller === '0x0000000000000000000000000000000000000000' ? null : { seller, price }
}

async function dealOfKey(key: string, buyer: string): Promise<DealView | null> {
  const raw = await registryPublicClient().readContract({ address: paywallAddress(), abi: PAYWALL_ABI, functionName: 'deal', args: [key as `0x${string}`, buyer as `0x${string}`] })
  const d = raw as unknown as DealView
  return d.state === 0 ? null : d
}

// ---- v2 order model: seller namespace + order snapshots + independent orderIds ----

export interface OrderViewV2 {
  seller: string
  buyer: string
  price: bigint
  feeBps: bigint
  state: number // 0 None / 1 Escrowed / 2 Delivered / 3 Released / 4 Refunded (same order as v1)
  purchasedAt: bigint
  deliveredAt: bigint
}

const writeOpsV2 = (signer: EvmSigner) => {
  const wallet = walletClientFor(signer)
  const account = accountOf(signer)
  const base = { address: paywallV2Address()!, abi: PAYWALL_V2_ABI, chain: autoEvmChain, account } as const
  return {
    setPrice: (key: `0x${string}`, price: bigint) =>
      wallet.writeContract({ ...base, functionName: 'setPrice', args: [key, price] }),
    // purchase must name the seller; maxPrice = the price the user saw (a changed price → PriceTooHigh)
    purchase: (key: `0x${string}`, seller: `0x${string}`, maxPrice: bigint) =>
      wallet.writeContract({ ...base, functionName: 'purchase', args: [key, seller, maxPrice], value: maxPrice }),
    markDelivered: (orderId: bigint) => wallet.writeContract({ ...base, functionName: 'markDelivered', args: [orderId] }),
    confirmReceipt: (orderId: bigint) => wallet.writeContract({ ...base, functionName: 'confirmReceipt', args: [orderId] }),
    refund: (orderId: bigint) => wallet.writeContract({ ...base, functionName: 'refund', args: [orderId] }),
    release: (orderId: bigint) => wallet.writeContract({ ...base, functionName: 'release', args: [orderId] }),
    withdraw: () => wallet.writeContract({ ...base, functionName: 'withdraw', args: [] }),
  }
}

export const setListingPriceV2 = (signer: EvmSigner, manifestCid: string, priceWei: bigint) =>
  paywallWrite(writeOpsV2(signer).setPrice(listingKey(manifestCid), priceWei))

export const purchaseV2 = (signer: EvmSigner, manifestCid: string, seller: string, priceWei: bigint) =>
  paywallWrite(writeOpsV2(signer).purchase(listingKey(manifestCid), seller as `0x${string}`, priceWei))

export const markDeliveredV2 = (signer: EvmSigner, orderId: bigint) =>
  paywallWrite(writeOpsV2(signer).markDelivered(orderId))

export const confirmReceiptV2 = (signer: EvmSigner, orderId: bigint) =>
  paywallWrite(writeOpsV2(signer).confirmReceipt(orderId))

export const refundDealV2 = (signer: EvmSigner, orderId: bigint) =>
  paywallWrite(writeOpsV2(signer).refund(orderId))

export const releaseDealV2 = (signer: EvmSigner, orderId: bigint) =>
  paywallWrite(writeOpsV2(signer).release(orderId))

export const withdrawCreditsV2 = (signer: EvmSigner) => paywallWrite(writeOpsV2(signer).withdraw())

export async function getCreditsV2(address: string): Promise<bigint> {
  return registryPublicClient().readContract({
    address: paywallV2Address()!,
    abi: PAYWALL_V2_ABI,
    functionName: 'credits',
    args: [address as `0x${string}`],
  })
}

/** v2 listing price (seller namespace); null = not listed */
export async function getListingPriceV2(seller: string, manifestCid: string): Promise<bigint | null> {
  const raw = await registryPublicClient().readContract({
    address: paywallV2Address()!,
    abi: PAYWALL_V2_ABI,
    functionName: 'listingPrice',
    args: [seller as `0x${string}`, listingKey(manifestCid)],
  })
  return (raw as bigint) > 0n ? (raw as bigint) : null
}

export async function getOrderV2(orderId: bigint): Promise<OrderViewV2 | null> {
  const raw = await registryPublicClient().readContract({
    address: paywallV2Address()!,
    abi: PAYWALL_V2_ABI,
    functionName: 'orders',
    args: [orderId],
  })
  const [seller, buyer, price, feeBps, state, purchasedAt, deliveredAt] = raw as unknown as [string, string, bigint, bigint, number, bigint, bigint]
  return state === 0 ? null : { seller, buyer, price, feeBps, state, purchasedAt, deliveredAt }
}

// ---- v2 purchase event scan (indexed buyer/seller filters + persisted incremental cursor) ----

const PURCHASED_V2 = parseAbiItem(
  'event Purchased(uint256 indexed orderId, address indexed buyer, address indexed seller, bytes32 key, uint96 price)',
)

/** incremental scan artifact (no state — state is read back on-chain each time;
 * the cache only holds static fields) */
export interface OrderStub {
  orderId: bigint
  key: string
  seller: string
  buyer: string
  price: bigint
  blockNumber: number
}

interface PersistedOrders {
  cursor: number // last block scanned (inclusive); 0 = never scanned
  stubs: OrderStub[]
}

const ordersCacheKey = (role: 'buyer' | 'seller', contract: string, account: string) =>
  `paywallOrders:${role}:${contract.toLowerCase()}:${account.toLowerCase()}`

async function scanPurchasedV2(filter: { buyer?: string; seller?: string }, fromBlock: number, toBlock: number): Promise<OrderStub[]> {
  const out: OrderStub[] = []
  for (let start = fromBlock; start <= toBlock; start += 10_000) {
    const logs = await registryPublicClient().getLogs({
      address: paywallV2Address()!,
      event: PURCHASED_V2,
      args: {
        ...(filter.buyer ? { buyer: filter.buyer as `0x${string}` } : {}),
        ...(filter.seller ? { seller: filter.seller as `0x${string}` } : {}),
      },
      fromBlock: BigInt(start),
      toBlock: BigInt(Math.min(start + 9_999, toBlock)),
    })
    for (const log of logs) {
      const a = log.args
      if (a?.orderId == null || !a.buyer || !a.seller || !a.key || a.price == null) continue
      out.push({ orderId: a.orderId, key: a.key, seller: a.seller.toLowerCase(), buyer: a.buyer.toLowerCase(), price: a.price, blockNumber: Number(log.blockNumber) })
    }
  }
  return out
}

/** merge incremental scan results (cursor advances only on success; failures
 * rethrow so the same range is rescanned next time) */
async function mergedStubs(role: 'buyer' | 'seller', filter: { buyer?: string; seller?: string }, deployBlock: number): Promise<OrderStub[]> {
  const contract = paywallV2Address()!
  const account = (filter.buyer ?? filter.seller)!.toLowerCase()
  const cacheKey = ordersCacheKey(role, contract, account)
  const persisted = (await getMeta<PersistedOrders>(cacheKey)) ?? { cursor: 0, stubs: [] }
  const latest = Number(await registryPublicClient().getBlockNumber())
  const from = persisted.cursor > deployBlock ? persisted.cursor + 1 : deployBlock
  const fresh = from <= latest ? await scanPurchasedV2(filter, from, latest) : []
  const byId = new Map<string, OrderStub>()
  for (const s of persisted.stubs) byId.set(String(s.orderId), s)
  for (const s of fresh) byId.set(String(s.orderId), s)
  const stubs = [...byId.values()]
  await putMeta(cacheKey, { cursor: latest, stubs } satisfies PersistedOrders)
  return stubs
}

/** buyer purchase records (v2): newest first; delisting never hides history
 * (order snapshots, no listing lookback) */
export async function fetchMyPurchasesV2(me: string): Promise<OrderRow[]> {
  const stubs = await mergedStubs('buyer', { buyer: me }, loadConfig().paywallV2DeployBlock)
  stubs.sort((a, b) => (a.orderId < b.orderId ? 1 : -1))
  const rows: OrderRow[] = []
  for (const s of stubs) {
    const o = await getOrderV2(s.orderId)
    if (!o) continue
    const entry = await entryByKey(s.seller, s.key)
    rows.push({ contract: 'v2', orderId: s.orderId, key: s.key, price: o.price, state: o.state, seller: s.seller, buyer: s.buyer, entry })
  }
  return rows
}

/** seller pending authorizations (v2): Purchased on keys listed in the caller's
 * own namespace, order still Escrowed */
export async function fetchPendingGrantsV2(seller: string): Promise<OrderRow[]> {
  const stubs = await mergedStubs('seller', { seller }, loadConfig().paywallV2DeployBlock)
  stubs.sort((a, b) => (a.orderId < b.orderId ? 1 : -1))
  const rows: OrderRow[] = []
  for (const s of stubs) {
    const o = await getOrderV2(s.orderId)
    if (!o || o.state !== 1) continue
    if (o.seller.toLowerCase() !== seller.toLowerCase()) continue // the order's snapshot seller must be the caller
    const entry = await entryByKey(seller, s.key)
    rows.push({ contract: 'v2', orderId: s.orderId, key: s.key, price: o.price, state: o.state, seller: s.seller, buyer: s.buyer, entry })
  }
  return rows
}

// ---- key delivery (rides the mailbox message channel) ----

export const PDGRANT_TYPE = 'pdgrant'

export interface PdGrant {
  type: 'pdgrant'
  manifestCid: string
  /** inner box envelope (the buyer unwraps K with their encryption private key) */
  wrappedK: string
  v?: 2
  chainId?: number
  paywall?: string
  orderId?: string
  buyer?: string
  seller?: string
}

export const isPdGrant = (plain: string): PdGrant | null => {
  try {
    const v = JSON.parse(plain) as PdGrant
    return v?.type === 'pdgrant' && typeof v.manifestCid === 'string' && typeof v.wrappedK === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * Seller delivery: unwrap K (signature channel first, falling back to the
 * passphrase prompt callback) → box it to the buyer's announced encryption
 * pubkey → pdgrant message → markDelivered. Semi-automatic (the seller's app
 * responds while online).
 */
export async function deliverKey(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  assertPaywallV2Active() // F01: legacy delivery is frozen (before any message/tx is sent)
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // self-trade (acceptance path): buyer == seller, the pdgrant channel is unnecessary — only markDelivered
  if (buyer.toLowerCase() === signer.address.toLowerCase()) {
    const deliveredTxHash = await markDelivered(signer, manifestCid, buyer)
    return { messageTxHash: '', deliveredTxHash }
  }
  const keyBytes = await unwrapManifestKey(signer, manifest, getPassphrase)
  const buyerKeyB64 = await getAnnouncedKey(buyer)
  if (!buyerKeyB64) throw new Error(t('errors.mailboxRecipientNoKey'))
  const inner = boxEncrypt(publicKeyFromBase64(buyerKeyB64), keyBytes)
  const grant: PdGrant = { type: 'pdgrant', manifestCid, wrappedK: JSON.stringify(inner) }
  const sent = await sendEncryptedMessage(signer, buyer, JSON.stringify(grant))
  const deliveredTxHash = await markDelivered(signer, manifestCid, buyer)
  return { messageTxHash: sent.txHash, deliveredTxHash }
}

/** v2 delivery: same as deliverKey, but markDelivered goes by orderId (order-snapshot model) */
export async function deliverKeyV2(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  orderId: bigint,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // self-trade (acceptance path): buyer == seller, the pdgrant channel is unnecessary — only markDelivered
  if (buyer.toLowerCase() === signer.address.toLowerCase()) {
    const deliveredTxHash = await markDeliveredV2(signer, orderId)
    return { messageTxHash: '', deliveredTxHash }
  }
  const keyBytes = await unwrapManifestKey(signer, manifest, getPassphrase)
  const buyerKeyB64 = await getAnnouncedKey(buyer)
  if (!buyerKeyB64) throw new Error(t('errors.mailboxRecipientNoKey'))
  const inner = boxEncrypt(publicKeyFromBase64(buyerKeyB64), keyBytes)
  const grant: PdGrant = {
    type: 'pdgrant',
    manifestCid,
    wrappedK: JSON.stringify(inner),
    v: 2,
    chainId: autoEvmChain.id,
    paywall: paywallV2Address() ?? undefined,
    orderId: orderId.toString(),
    buyer: buyer.toLowerCase(),
    seller: signer.address.toLowerCase(),
  }
  const sent = await sendEncryptedMessage(signer, buyer, JSON.stringify(grant))
  const deliveredTxHash = await markDeliveredV2(signer, orderId)
  return { messageTxHash: sent.txHash, deliveredTxHash }
}

/** unwrap K from the manifest's encryption block: signature channel first
 * (deterministic signer), falling back to the passphrase callback */
export async function unwrapManifestKey(
  signer: EvmSigner,
  manifest: Manifest,
  getPassphrase: () => Promise<string | null>,
): Promise<Uint8Array> {
  if (!manifest.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  const sigWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'signature-v1')
  if (sigWrap) {
    try {
      const wallet = walletClientFor(signer)
      const signature = fromHex(await wallet.signMessage({ message: sigWrap.message ?? '', account: accountOf(signer) }))
      const key = await tryUnwrapWithSignature(sigWrap, signature)
      if (key) return key
    } catch {
      // signature declined → fall back to the passphrase
    }
  }
  const passWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'passphrase-v1')
  if (!passWrap) throw new Error(t('errors.fileDecryptNoChannel'))
  const passphrase = await getPassphrase()
  if (passphrase === null) throw new Error(t('errors.fileDecryptCancelled'))
  return unwrapWithPassphrase(passWrap, passphrase)
}

/** buyer unwraps K from the pdgrant message plaintext (local keys derive
 * deterministically; injected wallets decrypt in-wallet) */
export async function unwrapDeliveredKey(signer: EvmSigner, grant: PdGrant): Promise<Uint8Array> {
  if (signer.kind === 'local') {
    const secret = await localBoxSecretKey(signer)
    return boxDecryptWithSecretKey(parseBoxEnvelope(grant.wrappedK), secret)
  }
  const bytes = await injectedDecrypt(signer.provider, signer.address, grant.wrappedK)
  return bytes
}
