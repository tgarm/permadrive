// 付费下载（P4 批次 C，doc/12 §五；v2 订单模型 doc/13 R01/R06）。key =
// keccak256(manifestCid)（与 Registry v2 manifestCidKey 同口径）。链上数据全
// 公开 ⇒ 文件密钥 K 以密文经 Mailbox 私信交付：买家 purchase → 卖家核验托管
// 状态（Escrowed）→ 解出 K 用买家加密公钥包裹 → pdgrant 消息 → markDelivered
// → 买家 confirmReceipt / grace 内 refund。无 keeper：每个状态迁移由利益方
// 主动发交易。数字商品模式（购买=获得文件，无 DRM，UI 明示）。
//
// 双实例策略（doc/13 R01 部署处置）：v1 Paywall 有「任意地址覆盖卖家」漏洞，
// 已冻结只读 —— paywallV2Address 配置后为活跃实例（新动作全走 v2），v1 订单
// 仅保留退款/确认/提现入口；v2 未配置时 v1 是唯一活跃实例（现行为）。
// v2 订单模型：Order 快照 seller/price/feeBps（下架/改价不影响存量订单）、
// 独立递增 orderId（Refunded 重购历史保留）、购买指明 seller + maxPrice。

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

/** v1（legacy）实例：有 R01 漏洞，冻结只读 —— 退款/确认/提现仍可用 */
export const paywallAddress = (): `0x${string}` => {
  const addr = loadConfig().paywallAddress
  if (!addrOk(addr)) throw new Error(t('errors.paywallNotConfigured'))
  return addr as `0x${string}`
}

/** v2 实例地址；未配置（部署前/未在 Settings 填写）返回 null */
export const paywallV2Address = (): `0x${string}` | null => {
  const addr = loadConfig().paywallV2Address
  return addrOk(addr) ? (addr as `0x${string}`) : null
}

/** v2 是否为活跃实例（新上架/购买/交付全走 v2） */
export const paywallV2Active = (): boolean => paywallV2Address() !== null

/** key = keccak256(manifestCid)（Registry v2 manifestCidKey 同口径） */
export const listingKey = (manifestCid: string): `0x${string}` => keccak256(toHex(manifestCid))

export interface Listing {
  seller: string
  price: bigint // 0 = 未上架
}

export async function getListing(manifestCid: string): Promise<Listing | null> {
  const raw = await registryPublicClient().readContract({
    address: paywallAddress(),
    abi: PAYWALL_ABI,
    functionName: 'listings',
    args: [listingKey(manifestCid)],
  })
  // 公共映射 getter 的 struct 返回是无名元组（solc 不给 components 命名）
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

/** 各写操作走字面量 functionName/args（viem writeContract 泛型按 ABI 推导） */
async function paywallWrite(op: Promise<`0x${string}`>): Promise<`0x${string}`> {
  const hash = await op
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
  return hash
}

const writeOps = (signer: EvmSigner) => {
  const wallet = walletClientFor(signer)
  const account = accountOf(signer)
  const base = { address: paywallAddress(), abi: PAYWALL_ABI, chain: autoEvmChain, account } as const
  return {
    setPrice: (key: `0x${string}`, price: bigint) =>
      wallet.writeContract({ ...base, functionName: 'setPrice', args: [key, price] }),
    purchase: (key: `0x${string}`, price: bigint) =>
      wallet.writeContract({ ...base, functionName: 'purchase', args: [key], value: price }),
    markDelivered: (key: `0x${string}`, buyer: `0x${string}`) =>
      wallet.writeContract({ ...base, functionName: 'markDelivered', args: [key, buyer] }),
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

export const setListingPrice = (signer: EvmSigner, manifestCid: string, priceWei: bigint) =>
  paywallWrite(writeOps(signer).setPrice(listingKey(manifestCid), priceWei))

export const purchase = (signer: EvmSigner, manifestCid: string, priceWei: bigint) =>
  paywallWrite(writeOps(signer).purchase(listingKey(manifestCid), priceWei))

export const markDelivered = (signer: EvmSigner, manifestCid: string, buyer: string) =>
  paywallWrite(writeOps(signer).markDelivered(listingKey(manifestCid), buyer as `0x${string}`))

export const confirmReceipt = (signer: EvmSigner, manifestCid: string) =>
  paywallWrite(writeOps(signer).confirmReceipt(listingKey(manifestCid)))

export const refundDeal = (signer: EvmSigner, manifestCid: string) =>
  paywallWrite(writeOps(signer).refund(listingKey(manifestCid)))

/** legacy 订单按 key 直操作：卖家下架后 manifestCid 无法从 key 反查，而退款/确认
 * 收货在 v1 合约上只依赖 key+buyer —— 保留入口（doc/13 R01 关联问题的前端兜底） */
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

// ---- 购买事件扫描（买家「我的购买」与卖家「待处理授权」共用） ----

const PURCHASED = parseAbiItem('event Purchased(bytes32 indexed key, address indexed buyer, uint96 price)')

export interface PurchaseLog {
  key: string
  buyer: string
  price: bigint
  txHash: string
  blockNumber: number
}

// RPC 硬限：eth_getLogs 区间 ≤ 10000 块（实测报错口径）
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

// seller → Registry entries 缓存（key 反查目录条目用；条目含 height 供 manifest 还原）
// R06 修复：带 TTL（目录可能新增），且网络失败不缓存为空成功结果（下次调用重试）
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
      return null // 失败不入缓存 —— 下次调用重试（不把网络故障当「无目录」）
    }
    entriesCache.set(cacheKey, { at: Date.now(), entries })
  }
  for (const e of entries) if (listingKey(e.manifestCid) === key) return e
  return null
}

/** UI 归一化行：legacy 与 v2 订单共用（组件不再通过当前 listing 反推卖家/状态） */
export interface OrderRow {
  contract: 'v2' | 'legacy'
  orderId: bigint | null // v2；legacy 为 null（v1 合约无订单 id）
  key: string
  price: bigint
  state: number // 0 None / 1 Escrowed / 2 Delivered / 3 Released / 4 Refunded（两合约枚举同序）
  seller: string // 反查不到时为 ''（legacy 下架后；此时退款/确认仍可用）
  buyer: string
  entry: RegistryEntry | null
}

/** 卖家待处理授权（legacy）：Purchased ∩ 自己的目录 key，且链上 Deal 仍为 Escrowed */
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

/** 买家购买记录（legacy）：Purchased（buyer=me）→ 当前 Deal 状态。
 * R06 修复：listing 查不到（卖家已下架）不再丢弃订单 —— 退款/确认收货仍可用，
 * 仅 manifest 反查（entry）不可用。 */
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

// ---- v2 订单模型（doc/13 R01/R06）：seller 命名空间 + 订单快照 + 独立 orderId ----

export interface OrderViewV2 {
  seller: string
  buyer: string
  price: bigint
  feeBps: bigint
  state: number // 0 None / 1 Escrowed / 2 Delivered / 3 Released / 4 Refunded（枚举与 v1 同序）
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
    // 购买必须指明 seller；maxPrice = 用户看到的成交价（价格变化 → PriceTooHigh 拒绝）
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

/** v2 上架价（seller 命名空间）；null = 未上架 */
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

// ---- v2 购买事件扫描（indexed buyer/seller 过滤 + 持久化增量游标，R06）----

const PURCHASED_V2 = parseAbiItem(
  'event Purchased(uint256 indexed orderId, address indexed buyer, address indexed seller, bytes32 key, uint96 price)',
)

/** 增量扫描产物（不含 state —— state 每次读链回填，缓存只存静态字段） */
export interface OrderStub {
  orderId: bigint
  key: string
  seller: string
  buyer: string
  price: bigint
  blockNumber: number
}

interface PersistedOrders {
  cursor: number // 已扫到（含）的块高；0 = 从未扫描
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

/** 合并增量扫描结果（成功才推进游标；失败原样上抛，下次重扫同区间） */
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

/** 买家购买记录（v2）：新单在前；下架不影响历史（订单快照，不反查 listing） */
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

/** 卖家待处理授权（v2）：Purchased ∩ 自己命名空间上架的 key，且订单仍为 Escrowed */
export async function fetchPendingGrantsV2(seller: string): Promise<OrderRow[]> {
  const stubs = await mergedStubs('seller', { seller }, loadConfig().paywallV2DeployBlock)
  stubs.sort((a, b) => (a.orderId < b.orderId ? 1 : -1))
  const rows: OrderRow[] = []
  for (const s of stubs) {
    const o = await getOrderV2(s.orderId)
    if (!o || o.state !== 1) continue
    if (o.seller.toLowerCase() !== seller.toLowerCase()) continue // 订单快照卖家必须是自己
    const entry = await entryByKey(seller, s.key)
    rows.push({ contract: 'v2', orderId: s.orderId, key: s.key, price: o.price, state: o.state, seller: s.seller, buyer: s.buyer, entry })
  }
  return rows
}

// ---- 密钥交付（骑 Mailbox 消息通道，doc/12 §五.C2） ----

export const PDGRANT_TYPE = 'pdgrant'

// R05: pdgrant v2 binds the order identity (chainId/paywall/orderId/buyer/
// seller) — the buyer verifies the message comes from the order's seller, is
// addressed to them and matches the order, so a wrong/forged candidate cannot
// shadow the correct delivery. v1 (no binding fields) still parses, for legacy
// orders only.
export interface PdGrant {
  type: 'pdgrant'
  manifestCid: string
  /** 内层盒信封（买家用自己的加密私钥解出 K） */
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
 * 卖家交付：解出 K（签名通道优先，失败回落口令弹窗回调）→ 用买家加密公钥
 * 包裹 → pdgrant 私信 → markDelivered。交付是半自动（卖家应用在线时响应）。
 */
export async function deliverKey(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // 自卖自买（e2e/验收口径）：买卖同一密钥，pdgrant 无信道必要，仅 markDelivered
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

/** v2 交付：同 deliverKey，但 markDelivered 走订单 id（订单快照模型） */
export async function deliverKeyV2(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  orderId: bigint,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // 自卖自买（e2e/验收口径）：买卖同一密钥，pdgrant 无信道必要，仅 markDelivered
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

/** 从 manifest 的加密块解出 K：签名通道优先（确定性签名者），失败回落口令回调 */
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
      // 签名被拒 → 回落口令
    }
  }
  const passWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'passphrase-v1')
  if (!passWrap) throw new Error(t('errors.fileDecryptNoChannel'))
  const passphrase = await getPassphrase()
  if (passphrase === null) throw new Error(t('errors.fileDecryptCancelled'))
  return unwrapWithPassphrase(passWrap, passphrase)
}

/** 买家从 pdgrant 消息明文解出 K（local 密钥确定性派生；injected 走钱包内解密） */
export async function unwrapDeliveredKey(signer: EvmSigner, grant: PdGrant): Promise<Uint8Array> {
  if (signer.kind === 'local') {
    const secret = await localBoxSecretKey(signer)
    return boxDecryptWithSecretKey(parseBoxEnvelope(grant.wrappedK), secret)
  }
  const bytes = await injectedDecrypt(signer.provider, signer.address, grant.wrappedK)
  return bytes
}
