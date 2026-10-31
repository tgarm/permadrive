// Direct sales: pay-and-split, no escrow, no refunds, positive/negative
// ratings. Runs in parallel with paywall.ts (the escrow model: v1 frozen /
// v2 deployment paused): once config.salesAddress is set, SalesSection mounts
// and the escrow section keeps only existing-order disposition. Contract
// essentials:
//  - listingId = keccak256(seller, fileKey), fileKey = keccak256(manifestCid)
//    (same derivation as Registry v2 / Paywall); immutable revisions, purchase
//    must name expectedRevision (the current revision) plus maxPrice/
//    maxPlatformBps/maxProviderBps slippage protection.
//  - Payment must equal the quote exactly (msg.value == price); the three-way
//    split (treasury/seller/optional providerPayout) completes in the same
//    transaction; any failed transfer reverts the whole purchase.
//  - Key delivery rides the Mailbox: pdgrant v3 (bound to chainId/sales/
//    orderId/buyer/seller/provider/fileKey/manifestCid); markKeySent is only an
//    optional state registration, never a precondition for the buyer to
//    decrypt and download.
//  - Ratings: actual buyers only (seller==buyer excluded), no delivery
//    precondition; one vote per buyer, changeable.

import { keccak256, parseAbiItem, toHex } from 'viem'
import { loadConfig } from './config.ts'
import { DIRECT_SALES_ABI } from './sales-abi.ts'
import { getMeta, putMeta } from './store.ts'
import { accountOf, fetchEntries, registryPublicClient, walletClientFor, type RegistryEntry } from './registry.ts'
import { autoEvmChain } from './evm.ts'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, parseEnvelope as parseBoxEnvelope, publicKeyFromBase64 } from './boxCrypto.ts'
import { getAnnouncedKey, localBoxSecretKey, sendEncryptedMessage } from './mailbox.ts'
import { unwrapManifestKey } from './paywall.ts'
import type { Manifest } from './manifest.ts'
import type { EvmSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

const addrOk = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const addrShaped = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** DirectSales instance address; null while unconfigured (before deployment / not set in Settings) */
export const salesAddress = (): `0x${string}` | null => {
  const addr = loadConfig().salesAddress
  return addrOk(addr) ? (addr as `0x${string}`) : null
}

export const salesActive = (): boolean => salesAddress() !== null

/** Same guard style as the v2 activation check: an explicit error when unconfigured (instead of viem's Invalid address) */
export function assertSalesActive(): void {
  if (!salesActive()) throw new Error(t('errors.salesNotConfigured'))
}

/** fileKey = keccak256(manifestCid) (same derivation as Registry v2's manifestCidKey) */
export const fileKeyOf = (manifestCid: string): `0x${string}` => keccak256(toHex(manifestCid))

export const listingIdOf = (seller: string, manifestCid: string): `0x${string}` =>
  keccak256(`0x${seller.slice(2).toLowerCase()}${fileKeyOf(manifestCid).slice(2)}`)

async function salesWrite(op: Promise<`0x${string}`>): Promise<`0x${string}`> {
  const hash = await op
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
  return hash
}

const writeOps = (signer: EvmSigner) => {
  assertSalesActive()
  const wallet = walletClientFor(signer)
  const account = accountOf(signer)
  const base = { address: salesAddress()!, abi: DIRECT_SALES_ABI, chain: autoEvmChain, account } as const
  return {
    createRevision: (fileKey: `0x${string}`, price: bigint) =>
      wallet.writeContract({
        ...base,
        functionName: 'createRevision',
        // Phase one is Seller mode only (provider=0/payout=0/bps=0, deliveryMode=0);
        // the service-delivery entry points are protocol-tested (adversarial coverage
        // alongside paywall-v2-test) but the UI comes later.
        // viem decode rules: uint8/uint16 → number, uint64 → bigint
        args: [fileKey, price, ZERO_ADDR, ZERO_ADDR, 0, 0, keccak256(toHex('')), 0n, '0x'],
      }),
    delist: (fileKey: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'delist', args: [fileKey] }),
    // Payment must equal the quote exactly: maxPrice = the price as seen (a reprice/
    // revision swap → rejected, buyer retries with a fresh view); the fee caps pass
    // the contract's hard caps (the buyer's slippage concern is the price, not the platform cut)
    purchase: (listingId: `0x${string}`, expectedRevision: bigint, maxPrice: bigint) =>
      wallet.writeContract({
        ...base,
        functionName: 'purchase',
        args: [listingId, expectedRevision, maxPrice, 2000, 5000],
        value: maxPrice,
      }),
    markKeySent: (orderId: bigint) =>
      wallet.writeContract({ ...base, functionName: 'markKeySent', args: [orderId] }),
    rate: (orderId: bigint, positive: boolean) =>
      wallet.writeContract({ ...base, functionName: 'rate', args: [orderId, positive] }),
  }
}

export const createRevisionSales = (signer: EvmSigner, manifestCid: string, priceWei: bigint) =>
  salesWrite(writeOps(signer).createRevision(fileKeyOf(manifestCid), priceWei))

export const delistSales = (signer: EvmSigner, manifestCid: string) =>
  salesWrite(writeOps(signer).delist(fileKeyOf(manifestCid)))

/** Listing info (current revision snapshot); null = not listed */
export interface ListingView {
  revision: bigint
  price: bigint
  platformBps: number
  providerBps: number
  deliveryMode: number
  seller: string
  provider: string
  revoked: boolean
}

export async function getListingSales(seller: string, manifestCid: string): Promise<ListingView | null> {
  const lid = listingIdOf(seller, manifestCid)
  const rid = (await registryPublicClient().readContract({
    address: salesAddress()!,
    abi: DIRECT_SALES_ABI,
    functionName: 'currentRevision',
    args: [lid],
  })) as bigint
  if (rid === 0n) return null
  const raw = (await registryPublicClient().readContract({
    address: salesAddress()!,
    abi: DIRECT_SALES_ABI,
    functionName: 'revisionOf',
    args: [lid, rid],
  })) as unknown as [bigint, bigint, number, number, number, string, string, string, `0x${string}`, `0x${string}`, boolean]
  const [price, , platformBps, providerBps, deliveryMode, , provider, , , , revoked] = raw
  return { revision: rid, price, platformBps, providerBps, deliveryMode, seller: seller.toLowerCase(), provider, revoked }
}

/** Pre-purchase read (immediate expectedRevision snapshot; the UI builds the exact quote from it) */
export async function purchaseQuote(seller: string, manifestCid: string): Promise<{ listingId: `0x${string}`; revision: bigint; price: bigint } | null> {
  const l = await getListingSales(seller, manifestCid)
  if (!l || l.revoked) return null
  return { listingId: listingIdOf(seller, manifestCid), revision: l.revision, price: l.price }
}

/** Purchase: when the quote goes stale (delisted/repriced/new revision) the contract rejects
 *  (NotCurrentRevision/PriceTooHigh) and the UI prompts a fresh view — no escrow means no
 *  "funds stuck in the wrong state" residue */
export const purchaseSalesWithQuote = (signer: EvmSigner, quote: { listingId: `0x${string}`; price: bigint; revision: bigint }) =>
  salesWrite(writeOps(signer).purchase(quote.listingId, quote.revision, quote.price))

export const markKeySentSales = (signer: EvmSigner, orderId: bigint) => salesWrite(writeOps(signer).markKeySent(orderId))

export const rateSales = (signer: EvmSigner, orderId: bigint, positive: boolean) => salesWrite(writeOps(signer).rate(orderId, positive))

// ---- order & rating reads ----

export interface OrderView {
  revision: bigint
  price: bigint
  platformBps: number
  providerBps: number
  state: number // 0 Paid / 1 KeySent
  purchasedAt: bigint
  buyer: string
  seller: string
  provider: string
  fileKey: string
}

export async function getOrderSales(orderId: bigint): Promise<OrderView | null> {
  const raw = (await registryPublicClient().readContract({
    address: salesAddress()!,
    abi: DIRECT_SALES_ABI,
    functionName: 'orderOf',
    args: [orderId],
  })) as unknown as [bigint, bigint, number, number, number, bigint, string, string, string, string, `0x${string}`]
  const [revision, price, platformBps, providerBps, state, purchasedAt, buyer, seller, provider, , fileKey] = raw
  if (buyer === ZERO_ADDR) return null
  return { revision, price, platformBps, providerBps, state, purchasedAt, buyer: buyer.toLowerCase(), seller: seller.toLowerCase(), provider: provider.toLowerCase(), fileKey }
}

export async function getRatingSales(seller: string, manifestCid: string): Promise<{ up: bigint; down: bigint; buyers: bigint }> {
  const [up, down, buyers] = (await registryPublicClient().readContract({
    address: salesAddress()!,
    abi: DIRECT_SALES_ABI,
    functionName: 'ratingOf',
    args: [listingIdOf(seller, manifestCid)],
  })) as unknown as [bigint, bigint, bigint]
  return { up, down, buyers }
}

export async function getVoteSales(seller: string, manifestCid: string, buyer: string): Promise<number> {
  const [choice] = (await registryPublicClient().readContract({
    address: salesAddress()!,
    abi: DIRECT_SALES_ABI,
    functionName: 'voteOf',
    args: [listingIdOf(seller, manifestCid), buyer as `0x${string}`],
  })) as unknown as [number, bigint]
  return choice
}

// ---- purchase event scan (indexed buyer/seller filter + persistent incremental cursor, same pattern as paywall.ts) ----

const PURCHASED_SALES = parseAbiItem(
  'event Purchased(uint256 indexed orderId, address indexed buyer, address indexed seller, bytes32 listingId, uint256 revision, bytes32 fileKey, address provider, uint96 price, uint16 platformBps, uint16 providerBps)',
)

interface OrderStub {
  orderId: bigint
  listingId: string
  fileKey: string
  seller: string
  buyer: string
  price: bigint
  blockNumber: number
}

interface PersistedOrders {
  cursor: number // highest block scanned (inclusive); 0 = never scanned
  checkpoint?: { height: number; hash: string } // block hash at cursor (reorg detection, same model as the Mailbox cursor)
  stubs: OrderStub[]
}

// Reorg lookback window (64 blocks, same as Mailbox): every sync rescans the
// recent window; a checkpoint hash mismatch at the cursor height (upstream
// reorg) falls back further — a bare incremental cursor misses orders / keeps
// orphans across reorgs
const RESCAN_LOOKBACK = 64

const ordersCacheKey = (role: 'buyer' | 'seller', contract: string, account: string) =>
  `salesOrders:${role}:${contract.toLowerCase()}:${account.toLowerCase()}`

async function scanPurchasedSales(filter: { buyer?: string; seller?: string }, fromBlock: number, toBlock: number): Promise<OrderStub[]> {
  const out: OrderStub[] = []
  for (let start = fromBlock; start <= toBlock; start += 10_000) {
    const logs = await registryPublicClient().getLogs({
      address: salesAddress()!,
      event: PURCHASED_SALES,
      args: {
        ...(filter.buyer ? { buyer: filter.buyer as `0x${string}` } : {}),
        ...(filter.seller ? { seller: filter.seller as `0x${string}` } : {}),
      },
      fromBlock: BigInt(start),
      toBlock: BigInt(Math.min(start + 9_999, toBlock)),
    })
    for (const log of logs) {
      const a = log.args
      if (a?.orderId == null || !a.buyer || !a.seller || !a.fileKey || a.price == null) continue
      out.push({
        orderId: a.orderId,
        listingId: a.listingId ?? '',
        fileKey: a.fileKey,
        seller: a.seller.toLowerCase(),
        buyer: a.buyer.toLowerCase(),
        price: a.price,
        blockNumber: Number(log.blockNumber),
      })
    }
  }
  return out
}

/** Merge incremental scan results (the cursor advances only on success; failures
 *  propagate and the same range is rescanned next time) */
async function mergedStubs(role: 'buyer' | 'seller', filter: { buyer?: string; seller?: string }, deployBlock: number): Promise<OrderStub[]> {
  const contract = salesAddress()!
  const account = (filter.buyer ?? filter.seller)!.toLowerCase()
  const cacheKey = ordersCacheKey(role, contract, account)
  const persisted = (await getMeta<PersistedOrders>(cacheKey)) ?? { cursor: 0, stubs: [] }
  const latest = Number(await registryPublicClient().getBlockNumber())
  let from = persisted.cursor > deployBlock ? persisted.cursor + 1 : deployBlock
  // Checkpoint pairing: if the frozen block hash no longer matches the on-chain
  // block at the same height, that range saw a reorg → roll the window back.
  // With a matching hash we still only step forward (no steady-state rescan;
  // deep reorgs beyond the window are out of scope, same as the Mailbox cursor).
  if (persisted.cursor > deployBlock && persisted.checkpoint?.height === persisted.cursor && persisted.checkpoint.hash) {
    try {
      const cur = await registryPublicClient().getBlock({ blockNumber: BigInt(persisted.cursor) })
      if (String(cur.hash).toLowerCase() !== persisted.checkpoint.hash.toLowerCase()) {
        from = Math.max(deployBlock, persisted.cursor - RESCAN_LOOKBACK)
      }
    } catch { /* block read failure falls back to the regular window */ }
  }
  from = Math.max(deployBlock, from - RESCAN_LOOKBACK) // steady-state lookback (idempotent merge absorbs overlap)
  const fresh = from <= latest ? await scanPurchasedSales(filter, from, latest) : []
  // Inside the window fresh wins (scanned stubs override; missing ones are
  // dropped = reorged-away orphans); history outside the window is preserved
  const freshIds = new Set(fresh.map((s) => String(s.orderId)))
  const byId = new Map<string, OrderStub>()
  for (const s of persisted.stubs) if (s.blockNumber < from || !freshIds.has(String(s.orderId))) byId.set(String(s.orderId), s)
  for (const s of fresh) byId.set(String(s.orderId), s)
  const stubs = [...byId.values()]
  let checkpoint: { height: number; hash: string } | undefined
  try {
    checkpoint = { height: latest, hash: String((await registryPublicClient().getBlock({ blockNumber: BigInt(latest) })).hash) }
  } catch { /* a missing checkpoint only loses next round's reorg detection */ }
  await putMeta(cacheKey, { cursor: latest, checkpoint, stubs } satisfies PersistedOrders)
  return stubs
}

// seller → Registry entries cache (fileKey reverse lookup into the directory; same TTL policy as paywall.ts)
const ENTRY_TTL_MS = 60_000
const entriesCache = new Map<string, { at: number; entries: Awaited<ReturnType<typeof fetchEntries>> }>()

async function entryByFileKey(seller: string, fileKey: string): Promise<RegistryEntry | null> {
  const cacheKey = seller.toLowerCase()
  const hit = entriesCache.get(cacheKey)
  let entries: Awaited<ReturnType<typeof fetchEntries>>
  if (hit && Date.now() - hit.at < ENTRY_TTL_MS) {
    entries = hit.entries
  } else {
    try {
      entries = await fetchEntries(seller)
    } catch {
      return null // failures are never cached — the next call retries (a network error is not "no directory")
    }
    entriesCache.set(cacheKey, { at: Date.now(), entries })
  }
  for (const e of entries) if (fileKeyOf(e.manifestCid) === fileKey) return e
  return null
}

export interface SalesOrderRow {
  orderId: bigint
  seller: string
  buyer: string
  provider: string
  price: bigint
  state: number
  entry: RegistryEntry | null
}

/** Buyer's purchase history (newest first; order snapshots, never re-checked against the current listing) */
export async function fetchMyOrdersSales(me: string): Promise<SalesOrderRow[]> {
  const stubs = await mergedStubs('buyer', { buyer: me }, loadConfig().salesDeployBlock)
  stubs.sort((a, b) => (a.orderId < b.orderId ? 1 : -1))
  const rows: SalesOrderRow[] = []
  for (const s of stubs) {
    const o = await getOrderSales(s.orderId)
    if (!o) continue
    if (o.fileKey.toLowerCase() !== s.fileKey.toLowerCase()) continue // event fileKey ≠ on-chain order = dirty log/reorg residue, drop
    const entry = await entryByFileKey(o.seller, o.fileKey) // look up by the on-chain order's fileKey (the event is only a cursor hint)
    rows.push({ orderId: s.orderId, seller: o.seller, buyer: o.buyer, provider: o.provider, price: o.price, state: o.state, entry })
  }
  return rows
}

/** Seller's pending deliveries: Purchased ∩ own namespace, still Paid */
export async function fetchSellerOrdersSales(seller: string): Promise<SalesOrderRow[]> {
  const stubs = await mergedStubs('seller', { seller }, loadConfig().salesDeployBlock)
  stubs.sort((a, b) => (a.orderId < b.orderId ? 1 : -1))
  const rows: SalesOrderRow[] = []
  for (const s of stubs) {
    const o = await getOrderSales(s.orderId)
    if (!o || o.state !== 0) continue
    if (o.seller.toLowerCase() !== seller.toLowerCase()) continue // the order's snapshot seller must be self
    if (o.fileKey.toLowerCase() !== s.fileKey.toLowerCase()) continue // same: drop dirty logs
    const entry = await entryByFileKey(seller, o.fileKey)
    rows.push({ orderId: s.orderId, seller: o.seller, buyer: o.buyer, provider: o.provider, price: o.price, state: o.state, entry })
  }
  return rows
}

// ---- key delivery (rides the Mailbox message channel; pdgrant v3 binds the sales contract and the order) ----

// The new grant names its version and the sales contract explicitly — bound to
// chainId/sales/orderId/buyer/seller/provider/fileKey/manifestCid. v1/v2 (escrow)
// keep parsing per paywall.ts.
export interface PdGrantV3 {
  type: 'pdgrant'
  manifestCid: string
  wrappedK: string
  v: 3
  chainId: number
  sales: string
  orderId: string
  buyer: string
  seller: string
  provider?: string
}

export const isPdGrantV3 = (plain: string): PdGrantV3 | null => {
  try {
    const v = JSON.parse(plain) as PdGrantV3
    // Full shape validation — a malformed/forged-shaped grant never becomes a
    // delivery candidate (domain matching is done by the consumer's findGrant)
    if (v?.type !== 'pdgrant' || v?.v !== 3) return null
    if (typeof v.manifestCid !== 'string' || !v.manifestCid) return null
    if (typeof v.wrappedK !== 'string' || !v.wrappedK) return null
    if (typeof v.chainId !== 'number' || !Number.isFinite(v.chainId)) return null
    if (!addrShaped(v.sales) || !addrShaped(v.buyer) || !addrShaped(v.seller)) return null
    if (typeof v.orderId !== 'string' || !/^\d+$/.test(v.orderId)) return null
    if (v.provider !== undefined && !addrShaped(v.provider)) return null
    return v
  } catch {
    return null
  }
}

/** Seller delivery (phase one provider=0; the provider-delivery entry ships with the service UI later):
 *  unwrap K → pdgrant v3 private message (over the Mailbox E2E channel) → markKeySent (optional state registration) */
export async function deliverKeySales(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  orderId: bigint,
  provider: string,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  assertSalesActive()
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // self-purchase (e2e/acceptance path): a pdgrant channel is pointless, only markKeySent
  if (buyer.toLowerCase() === signer.address.toLowerCase()) {
    const deliveredTxHash = await markKeySentSales(signer, orderId)
    return { messageTxHash: '', deliveredTxHash }
  }
  const keyBytes = await unwrapManifestKey(signer, manifest, getPassphrase)
  const buyerKeyB64 = await getAnnouncedKey(buyer)
  if (!buyerKeyB64) throw new Error(t('errors.mailboxRecipientNoKey'))
  const inner = boxEncrypt(publicKeyFromBase64(buyerKeyB64), keyBytes)
  const grant: PdGrantV3 = {
    type: 'pdgrant',
    manifestCid,
    wrappedK: JSON.stringify(inner),
    v: 3,
    chainId: autoEvmChain.id,
    sales: salesAddress()!,
    orderId: orderId.toString(),
    buyer: buyer.toLowerCase(),
    seller: signer.address.toLowerCase(),
    provider: provider && provider !== ZERO_ADDR ? provider.toLowerCase() : undefined,
  }
  const sent = await sendEncryptedMessage(signer, buyer, JSON.stringify(grant))
  const deliveredTxHash = await markKeySentSales(signer, orderId)
  return { messageTxHash: sent.txHash, deliveredTxHash }
}

/** Buyer unwraps K from a pdgrant v3 message plaintext (same derivation as paywall.unwrapDeliveredKey) */
export async function unwrapDeliveredKeySales(signer: EvmSigner, grant: PdGrantV3): Promise<Uint8Array> {
  if (signer.kind === 'local') {
    const secret = await localBoxSecretKey(signer)
    return boxDecryptWithSecretKey(parseBoxEnvelope(grant.wrappedK), secret)
  }
  return injectedDecrypt(signer.provider, signer.address, grant.wrappedK)
}
