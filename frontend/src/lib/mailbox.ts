// On-chain mailbox orchestration (P4 batch B). Contract events ARE the mailbox:
// announceEncryptionKey registers the encryption pubkey (no receiving without
// it); send stores an end-to-end encrypted envelope; receiving scans via viem
// getLogs from the deploy block / cursor, decrypts and caches plaintext in
// IndexedDB, persists the cursor.
// Channel choice: local signers use a locally derived x25519 keypair (same
// mnemonic decrypts across devices); injected = wallet-managed
// (eth_getEncryptionPublicKey / eth_decrypt, MetaMask-style format).
// Batch C paid delivery reuses boxEncrypt.
// Privacy boundary: the communication graph (who talks to whom), timing and
// ciphertext length are public; only content is E2E protected.

import { parseAbiItem } from 'viem'
import { loadConfig } from './config.ts'
import { fromHex } from './bytes.ts'
import { MAILBOX_ABI } from './mailbox-abi.ts'
import { accountOf, registryPublicClient, walletClientFor, waitWritten } from './registry.ts'
import { autoEvmChain } from './evm.ts'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, injectedEncryptionPublicKey, localBoxKeypair, parseEnvelope, serializeEnvelope } from './boxCrypto.ts'
import { getMeta, listMessages, putMessage, putMessageDecryptResult, putMessagesWithCursor, type MessageRecord } from './store.ts'
import type { EvmSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

export const mailboxAddress = (): `0x${string}` => {
  const addr = loadConfig().mailboxAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) throw new Error(t('errors.mailboxNotConfigured'))
  return addr as `0x${string}`
}

// getLogs 单段扫描上限：RPC 硬限 eth_getLogs 区间 ≤ 10000 块（实测报错口径）
const SCAN_CHUNK = 10_000

// MessageSent 事件（parseAbiItem 给 getLogs 正确的 args 类型推导）
const MESSAGE_SENT = parseAbiItem('event MessageSent(uint256 indexed id, address indexed from, address indexed to, string content, uint64 sentAt)')

// ---- 加密公钥 ----

/** Local channel keypair cache (one signature per address; the keypair stays in memory only) */
const localKeypairCache = new Map<string, Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }>>()

function localKeypairFor(signer: EvmSigner): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  if (signer.kind !== 'local' || !signer.account) throw new Error(t('errors.localNoAccount'))
  const cacheKey = signer.address.toLowerCase()
  if (!localKeypairCache.has(cacheKey)) {
    localKeypairCache.set(
      cacheKey,
      localBoxKeypair(async (message) => {
        const wallet = walletClientFor(signer)
        return fromHex(await wallet.signMessage({ message, account: signer.account! }))
      }, signer.address),
    )
  }
  return localKeypairCache.get(cacheKey)!
}

/** This signer's encryption pubkey (base64): local = locally derived; injected = wallet-managed */
export async function encryptionPublicKeyFor(signer: EvmSigner): Promise<string> {
  if (signer.kind === 'local') return b64Of((await localKeypairFor(signer)).publicKey)
  return injectedEncryptionPublicKey(signer.provider!, signer.address)
}

/** Local channel decryption secret (unwraps the paywall pdgrant inner envelope; injected wallets decrypt in-wallet, not here) */
export async function localBoxSecretKey(signer: EvmSigner): Promise<Uint8Array> {
  if (signer.kind !== 'local' || !signer.account) throw new Error(t('errors.localNoAccount'))
  return (await localKeypairFor(signer)).secretKey
}

const b64Of = (b: Uint8Array): string => btoa(String.fromCharCode(...b))

export async function getAnnouncedKey(address: string): Promise<string | null> {
  const key = await registryPublicClient().readContract({
    address: mailboxAddress(),
    abi: MAILBOX_ABI,
    functionName: 'keys',
    args: [address as `0x${string}`],
  })
  return typeof key === 'string' && key.length > 0 ? key : null
}

/**
 * Ensure this signer's encryption pubkey is on-chain (idempotent: zero tx when
 * already registered with the same value). Called automatically after wallet
 * connect (no announce = no receiving); MessagesPage also calls it for status.
 */
export async function ensureAnnounced(signer: EvmSigner): Promise<{ key: string; txHash: string | null }> {
  const key = await encryptionPublicKeyFor(signer)
  const existing = await getAnnouncedKey(signer.address)
  if (existing === key) return { key, txHash: null }
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: mailboxAddress(),
    abi: MAILBOX_ABI,
    functionName: 'announceEncryptionKey',
    args: [key],
    chain: undefined,
    account: accountOf(signer),
  })
  await waitWritten(hash)
  return { key, txHash: hash }
}

// ---- 发信 ----

export interface SendResult {
  txHash: string
  eventId: number
}

/** Encrypt, send on-chain (throws if the recipient never announced); the sender caches its own plaintext (local only) */
export async function sendEncryptedMessage(signer: EvmSigner, to: string, plaintext: string): Promise<SendResult> {
  const toLower = to.toLowerCase()
  const recipientKey = await getAnnouncedKey(toLower)
  if (!recipientKey) throw new Error(t('errors.mailboxRecipientNoKey'))
  const envelope = boxEncrypt(fromB64(recipientKey), new TextEncoder().encode(plaintext))
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: mailboxAddress(),
    abi: MAILBOX_ABI,
    functionName: 'send',
    args: [toLower as `0x${string}`, serializeEnvelope(envelope)],
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
  // 事件 id 从回执日志取（以 receipt 为准不依赖并发时序）
  const sentLog = receipt.logs.find((l) => l.address.toLowerCase() === mailboxAddress().toLowerCase())
  const eventId = decodeEventId(sentLog)
  const block = await registryPublicClient().getBlock({ blockNumber: receipt.blockNumber })
  await putMessage({
    id: `${mailboxAddress().toLowerCase()}:${eventId}:${hash}`,
    eventId,
    from: signer.address.toLowerCase(),
    to: toLower,
    content: serializeEnvelope(envelope),
    plain: plaintext,
    at: Number(block.timestamp) * 1000,
    txHash: hash,
    read: true,
    sentByMe: true,
    chainId: autoEvmChain.id,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    decryptStatus: 'ok',
    decryptError: null,
  })
  return { txHash: hash, eventId }
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// MessageSent event id decoding (topics[1])
function decodeEventId(log: { topics: readonly `0x${string}`[] } | undefined): number {
  if (!log || !log.topics[1]) return -1
  return Number(BigInt(log.topics[1]))
}

// ---- receiving (getLogs + cursor; R03/R04 redesign) ----
// Sync and decryption are separated: syncMessages only pulls ciphertexts
// (decryptStatus='locked') — the cursor means "logs persisted", nothing more.
// Decryption is independent (local can auto-decrypt offline; injected must be
// user-initiated so background polling never spams wallet prompts). Failures
// persist their reason and are retryable per message without blocking others.

export interface SyncResult {
  scanned: number
  inbox: number
  outbox: number
  fromBlock: number
  toBlock: number
}

// The cursor is isolated by the (chainId, contract, account) triple (R04: switching contracts/chains never shares a cursor)
export const cursorKeyFor = (contract: string, account: string): string =>
  `mailboxCursor:${autoEvmChain.id}:${contract}:${account.toLowerCase()}`

// The legacy cursor key held only the address (value = plain block number) — migrated once to the triple key
async function loadCursor(contract: string, account: string): Promise<{ block: number; blockHash: string | null }> {
  const key = cursorKeyFor(contract, account)
  const cur = await getMeta<{ block: number; blockHash: string | null }>(key)
  if (cur) return { block: Number(cur.block) || 0, blockHash: cur.blockHash ?? null }
  const legacy = await getMeta<number>(`mailboxCursor:${account.toLowerCase()}`)
  if (typeof legacy === 'number' && legacy > 0) return { block: legacy, blockHash: null }
  return { block: 0, blockHash: null }
}

// Scan lookback window: rescan a few blocks before the cursor (idempotent merge, covers shallow reorgs around the cursor write)
const RESCAN_LOOKBACK = 64

// Per-account sync guard: an in-flight sync for the same (contract, account) is reused
const syncInFlight = new Map<string, Promise<SyncResult>>()

export async function syncMessages(me: string, signer: EvmSigner | null): Promise<SyncResult> {
  const meLower = me.toLowerCase()
  const contract = mailboxAddress().toLowerCase()
  const key = `${contract}:${meLower}`
  const inFlight = syncInFlight.get(key)
  if (inFlight) return inFlight
  const p = syncMessagesInner(meLower, contract, signer).finally(() => syncInFlight.delete(key))
  syncInFlight.set(key, p)
  return p
}

async function syncMessagesInner(meLower: string, contract: string, signer: EvmSigner | null): Promise<SyncResult> {
  const deployBlock = loadConfig().mailboxDeployBlock
  let cursor = await loadCursor(contract, meLower)
  if (cursor.block < deployBlock) cursor = { block: deployBlock, blockHash: null }
  // Reorg check (R04): checkpoint blockHash no longer matches the chain → rewind the window and rescan (merge is idempotent)
  if (cursor.blockHash) {
    try {
      const checkpoint = await registryPublicClient().getBlock({ blockNumber: BigInt(cursor.block) })
      if (checkpoint.hash.toLowerCase() !== cursor.blockHash.toLowerCase()) {
        cursor = { block: Math.max(deployBlock, cursor.block - RESCAN_LOOKBACK), blockHash: null }
      }
    } catch {
      // the checkpoint block is no longer readable (deep reorg) — rewind too
      cursor = { block: Math.max(deployBlock, cursor.block - RESCAN_LOOKBACK), blockHash: null }
    }
  }
  const fromBlock = Math.max(deployBlock, cursor.block - RESCAN_LOOKBACK)
  const latest = await registryPublicClient().getBlockNumber()
  const toBlock = Number(latest)
  if (toBlock < fromBlock) return { scanned: 0, inbox: 0, outbox: 0, fromBlock, toBlock }

  type MessageSentLog = Awaited<ReturnType<typeof scanChunk>>[number]
  // 单段扫描抽出便于类型推导（viem getLogs 的 args 由 parseAbiItem 事件驱动）
  async function scanChunk(start: number, end: number) {
    return registryPublicClient().getLogs({
      address: mailboxAddress(),
      event: MESSAGE_SENT,
      fromBlock: BigInt(start),
      toBlock: BigInt(end),
    })
  }
  const inbox: MessageSentLog[] = []
  const outbox: MessageSentLog[] = []
  for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
    const end = Math.min(start + SCAN_CHUNK - 1, toBlock)
    const logs = await scanChunk(start, end)
    for (const log of logs) {
      const args = log.args
      if (args.from?.toLowerCase() === meLower) outbox.push(log)
      else if (args.to?.toLowerCase() === meLower) inbox.push(log)
    }
  }

  // store ciphertexts only; the batch + cursor commit in one transaction (a failed batch never advances the cursor, R08)
  const records: Parameters<typeof putMessagesWithCursor>[0] = []
  for (const log of [...inbox, ...outbox]) {
    const args = log.args
    // viem 事件 args 可空（匿名日志口径）—— 字段缺失跳过
    if (!args || !args.from || !args.to || !args.content || args.sentAt == null) continue
    const isInbox = inbox.includes(log)
    records.push({
      id: `${contract}:${Number(args.id)}:${log.transactionHash}`,
      eventId: Number(args.id),
      from: args.from.toLowerCase(),
      to: args.to.toLowerCase(),
      content: args.content,
      plain: null, // sync never touches plaintext — existing plaintext is preserved by merge
      at: Number(args.sentAt) * 1000,
      txHash: log.transactionHash,
      read: !isInbox,
      sentByMe: !isInbox,
      chainId: autoEvmChain.id,
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash ?? null,
      decryptStatus: 'locked',
      decryptError: null,
    })
  }
  const checkpoint = toBlock > 0 ? await registryPublicClient().getBlock({ blockNumber: latest }).catch(() => null) : null
  await putMessagesWithCursor(
    records,
    cursorKeyFor(contract, meLower),
    { block: toBlock + 1, blockHash: checkpoint ? String(checkpoint.hash) : null },
  )

  // local signers can decrypt offline (no user interaction) — decrypt right after sync; injected is left to the UI
  if (signer?.kind === 'local') {
    try {
      await decryptPendingMessages(signer)
    } catch {
      // decryption failure is not a sync failure (messages are persisted; retry later)
    }
  }
  return { scanned: inbox.length + outbox.length, inbox: inbox.length, outbox: outbox.length, fromBlock, toBlock }
}

// ---- decryption (R03: independent from sync, retryable, per-message isolation) ----

/** Decrypt one locked/failed message with the current signer; returns the plaintext and persists it, or throws (reason persisted) */
export async function decryptMessage(signer: EvmSigner, record: MessageRecord): Promise<string> {
  if (record.sentByMe && record.plain != null) return record.plain
  let plain: string
  if (signer.kind === 'local') {
    const secret = await localBoxSecretKey(signer)
    try {
      plain = new TextDecoder().decode(boxDecryptWithSecretKey(parseEnvelope(record.content), secret))
    } catch (e) {
      await putMessageDecryptResult(record.id, null, (e as Error).message)
      throw new Error(t('errors.boxDecryptFailed'))
    }
  } else if (signer.kind === 'injected' && signer.provider) {
    try {
      plain = new TextDecoder().decode(await injectedDecrypt(signer.provider, signer.address, record.content))
    } catch (e) {
      await putMessageDecryptResult(record.id, null, (e as Error).message)
      throw new Error(t('errors.boxDecryptFailed'))
    }
  } else {
    throw new Error(t('errors.localNoAccount'))
  }
  await putMessageDecryptResult(record.id, plain, null)
  return plain
}

/** Decrypt all locked/failed messages addressed to this account (per-message isolation); returns the success count */
export async function decryptPendingMessages(signer: EvmSigner): Promise<number> {
  const meLower = signer.address.toLowerCase()
  let okCount = 0
  for (const m of await listMessages()) {
    if (m.decryptStatus === 'ok' && m.plain != null) continue
    if (m.sentByMe) continue // outbox plaintext is local-only; not restored across devices
    if (m.to.toLowerCase() !== meLower) continue
    try {
      await decryptMessage(signer, m)
      okCount++
    } catch {
      // single-message isolation; the reason is persisted (decryptError)
    }
  }
  return okCount
}
