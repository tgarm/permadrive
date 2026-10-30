// Paid downloads: Paywall escrow state-machine interaction + the key-delivery
// protocol. key = keccak256(manifestCid) (the same digest the registry uses
// for its manifestCidKey). On-chain data is public, so the file key K is
// delivered as ciphertext over the mailbox: buyer purchases → the seller
// verifies the on-chain deal is Escrowed → unwraps K, boxes it to the buyer's
// announced encryption pubkey, sends a pdgrant message → markDelivered → the
// buyer confirms receipt (or refunds within the grace period). No keeper:
// every state transition is triggered by an interested party. Digital-goods
// mode (buying grants the file, no DRM) is stated in the UI.

import { keccak256, parseAbiItem, toHex } from 'viem'
import { loadConfig } from './config'
import { PAYWALL_ABI } from './paywall-abi'
import { accountOf, fetchEntries, registryPublicClient, walletClientFor, type RegistryEntry } from './registry'
import { autoEvmChain } from './evm'
import { fromHex } from './bytes.ts'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, parseEnvelope as parseBoxEnvelope, publicKeyFromBase64 } from './boxCrypto.ts'
import { getAnnouncedKey, localBoxSecretKey, sendEncryptedMessage } from './mailbox'
import { tryUnwrapWithSignature, unwrapWithPassphrase } from './vaultCrypto.ts'
import type { Manifest } from './manifest'
import type { EvmSigner } from './wallet/types'
import { t } from '../i18n/core.ts'

export const paywallAddress = (): `0x${string}` => {
  const addr = loadConfig().paywallAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) throw new Error(t('errors.paywallNotConfigured'))
  return addr as `0x${string}`
}

/** key = keccak256(manifestCid) (same digest as the registry's manifestCidKey) */
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
  // a public mapping getter returns the struct as an unnamed tuple (solc emits no component names)
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

/** Each write passes literal functionName/args (viem writeContract derives types from the ABI) */
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

// ---- Purchase event scanning (shared by the buyer's purchases and the seller's pending authorisations) ----

const PURCHASED = parseAbiItem('event Purchased(bytes32 indexed key, address indexed buyer, uint96 price)')

export interface PurchaseLog {
  key: string
  buyer: string
  price: bigint
  txHash: string
  blockNumber: number
}

// RPC hard limit: eth_getLogs block range ≤ 10000 blocks (verified)
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

export interface PurchaseView {
  log: PurchaseLog
  deal: DealView
  seller: string
  /** The reverse-looked-up registry entry (manifestCid + height restore the manifest; null if the seller never registered it) */
  entry: RegistryEntry | null
}

// seller → registry entries cache (key → entry reverse lookup; the entry's height restores the manifest)
const entriesCache = new Map<string, Awaited<ReturnType<typeof fetchEntries>>>()

async function entryByKey(seller: string, key: string): Promise<RegistryEntry | null> {
  let entries = entriesCache.get(seller.toLowerCase())
  if (!entries) {
    entries = await fetchEntries(seller).catch(() => [])
    entriesCache.set(seller.toLowerCase(), entries)
  }
  for (const e of entries) if (listingKey(e.manifestCid) === key) return e
  return null
}

/** Seller's pending authorisations: Purchased events ∩ own listing keys whose on-chain Deal is still Escrowed */
export async function fetchPendingGrants(seller: string): Promise<PurchaseView[]> {
  const myKeys = new Set((await fetchEntries(seller)).map((e) => listingKey(e.manifestCid)))
  if (myKeys.size === 0) return []
  const logs = await fetchPurchasedLogs(loadConfig().paywallDeployBlock)
  const pending: PurchaseView[] = []
  for (const log of logs) {
    if (!myKeys.has(log.key as `0x${string}`)) continue
    const deal = await dealOfKey(log.key, log.buyer)
    if (deal && deal.state === 1) {
      const entry = await entryByKey(seller, log.key)
      pending.push({ log, deal, seller, entry })
    }
  }
  return pending
}

/** Buyer's purchase records: Purchased (buyer=me) → listing reverse-lookup of the seller → current Deal state */
export async function fetchMyPurchases(me: string): Promise<PurchaseView[]> {
  const logs = await fetchPurchasedLogs(loadConfig().paywallDeployBlock)
  const mine = logs.filter((l) => l.buyer === me.toLowerCase())
  const out: PurchaseView[] = []
  for (const log of mine) {
    const listing = await listingOfKey(log.key)
    if (!listing) continue
    const deal = await dealOfKey(log.key, me)
    if (!deal) continue
    const entry = await entryByKey(listing.seller, log.key)
    out.push({ log, deal, seller: listing.seller, entry })
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

// ---- Key delivery (rides the mailbox message channel) ----

export const PDGRANT_TYPE = 'pdgrant'

export interface PdGrant {
  type: 'pdgrant'
  manifestCid: string
  /** The inner box envelope (the buyer opens it with their own encryption secret key to get K) */
  wrappedK: string
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
 * Seller delivery: unwrap K (signature channel first, passphrase-modal
 * callback as fallback) → box it to the buyer's encryption pubkey → pdgrant
 * message → markDelivered. Delivery is semi-automatic (the seller's app
 * responds when online).
 */
export async function deliverKey(
  signer: EvmSigner,
  manifestCid: string,
  manifest: Manifest | null,
  buyer: string,
  getPassphrase: () => Promise<string | null>,
): Promise<{ messageTxHash: string; deliveredTxHash: string }> {
  if (!manifest?.encryption) throw new Error(t('errors.paywallNotEncrypted'))
  // Self-trade (e2e/acceptance flows): buyer and seller share the same key —
  // no pdgrant channel is needed, just markDelivered
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

/** Unwrap K from a manifest's encryption block: signature channel first (deterministic signers), passphrase callback as fallback */
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
      // signature refused → fall back to the passphrase
    }
  }
  const passWrap = manifest.encryption.wrappedKeys.find((w) => w.mode === 'passphrase-v1')
  if (!passWrap) throw new Error(t('errors.fileDecryptNoChannel'))
  const passphrase = await getPassphrase()
  if (passphrase === null) throw new Error(t('errors.fileDecryptCancelled'))
  return unwrapWithPassphrase(passWrap, passphrase)
}

/** Buyer side: unwrap K from a pdgrant message plaintext (local derived keypair; injected wallets decrypt in-wallet) */
export async function unwrapDeliveredKey(signer: EvmSigner, grant: PdGrant): Promise<Uint8Array> {
  if (signer.kind === 'local') {
    const secret = await localBoxSecretKey(signer)
    return boxDecryptWithSecretKey(parseBoxEnvelope(grant.wrappedK), secret)
  }
  const bytes = await injectedDecrypt(signer.provider, signer.address, grant.wrappedK)
  return bytes
}
