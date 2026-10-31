// On-chain mailbox orchestration. The contract's events are the mailbox:
// announceEncryptionKey registers an encryption pubkey (you cannot receive
// without announcing); send stores an end-to-end encrypted envelope. Incoming
// mail is scanned with viem getLogs (the frontend's first consumer) from the
// deployment block / persisted cursor, decrypted plaintext is cached in
// IndexedDB, and the cursor is persisted. Channel choice: local signers use
// the derived x25519 keypair (the same mnemonic decrypts on any device);
// injected wallets use their hosted keys (eth_getEncryptionPublicKey /
// eth_decrypt, MetaMask format, pending real-device verification). The paid-
// download delivery reuses boxEncrypt.
// Privacy boundary: who talks to whom, when, and ciphertext length are
// public; only the content is protected end-to-end.

import { parseAbiItem } from 'viem'
import { loadConfig } from './config.ts'
import { fromHex } from './bytes.ts'
import { MAILBOX_ABI } from './mailbox-abi.ts'
import { accountOf, registryPublicClient, walletClientFor, waitWritten } from './registry.ts'
import { autoEvmChain } from './evm.ts'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, injectedEncryptionPublicKey, localBoxKeypair, parseEnvelope, serializeEnvelope } from './boxCrypto.ts'
import { getMeta, listMessages, putMessage, putMessageDecryptResult, putMessagesWithCursor, type MessageRecord } from './store.ts'
import type { EvmSigner } from './wallet/types'
import { t } from '../i18n/core.ts'

export const mailboxAddress = (): `0x${string}` => {
  const addr = loadConfig().mailboxAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) throw new Error(t('errors.mailboxNotConfigured'))
  return addr as `0x${string}`
}

// eth_getLogs block range is hard-capped at 10000 blocks by the RPC (verified)
const SCAN_CHUNK = 10_000

// MessageSent event (parseAbiItem gives getLogs proper args typing)
const MESSAGE_SENT = parseAbiItem('event MessageSent(uint256 indexed id, address indexed from, address indexed to, string content, uint64 sentAt)')

// ---- Encryption pubkey ----

/** Local-channel keypair cache (one signature per address; keypair stays in memory) */
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

/** This signer's encryption pubkey (base64): local = derived; injected = wallet-hosted */
export async function encryptionPublicKeyFor(signer: EvmSigner): Promise<string> {
  if (signer.kind === 'local') return b64Of((await localKeypairFor(signer)).publicKey)
  return injectedEncryptionPublicKey(signer.provider!, signer.address)
}

/** Local-channel decryption secret key (unwraps paywall pdgrant inner envelopes; injected wallets decrypt in-wallet instead) */
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
 * Make sure this signer's encryption pubkey is on-chain (idempotent: a
 * matching registration costs zero transactions). Called automatically when
// the wallet connects (you cannot receive without announcing); MessagesPage
 * also calls it to surface the status.
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

// ---- Sending ----

export interface SendResult {
  txHash: string
  eventId: number
}

/** Encrypt and send on-chain (throws if the recipient has not announced); the outbox plaintext is cached locally only */
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
  // Event id comes from the receipt logs (receipt is authoritative regardless of concurrency)
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

// Decode the MessageSent event id (topics[1])
function decodeEventId(log: { topics: readonly `0x${string}`[] } | undefined): number {
  if (!log || !log.topics[1]) return -1
  return Number(BigInt(log.topics[1]))
}

// ---- receiving (getLogs + cursor; R03/R04 redesign, F04 second review) ----
// Sync and decryption are separated: syncMessages only pulls ciphertexts
// (decryptStatus='locked') — the cursor means "logs persisted", nothing more.
// Decryption is independent (local can auto-decrypt offline; injected must be
// user-initiated so background polling never spams wallet prompts). Failures
// persist their reason and are retryable per message without blocking others.
//
// F04: the cursor value is { nextBlock, checkpoint:{height,hash} } — nextBlock
// is "the next block to scan" and the checkpoint stores the block hash at that
// SAME height (the old code stored the hash of toBlock paired with a query
// height of toBlock+1, so even a perfectly healthy chain mismatched on every
// sync and misdetected a reorg). Reorg rewind only rescans/merges; log records
// inside the rescan window that no longer exist on-chain are deleted in the
// same transaction (orphaned messages and dead grants leave no residue).

export interface SyncResult {
  scanned: number
  inbox: number
  outbox: number
  fromBlock: number
  toBlock: number
}

export interface MailboxCursor {
  nextBlock: number
  checkpoint: { height: number; hash: string } | null
}

/** Cursor value normalization: current format {nextBlock, checkpoint}; legacy
 * {block, blockHash} (block = nextBlock, blockHash was the hash of block-1 —
 * exactly the same pairing the new semantics express); older still, a plain
 * block number (no checkpoint). Anything malformed resets to zero (rescanning
 * extra is idempotent-merged, so that is always safe) */
export function normalizeCursor(raw: unknown): MailboxCursor {
  if (raw && typeof raw === 'object' && 'nextBlock' in raw) {
    const r = raw as { nextBlock: unknown; checkpoint: unknown }
    const cp = r.checkpoint as { height: unknown; hash: unknown } | null
    return {
      nextBlock: Number(r.nextBlock) || 0,
      checkpoint: cp && typeof cp.height === 'number' && typeof cp.hash === 'string' ? { height: cp.height, hash: cp.hash } : null,
    }
  }
  if (raw && typeof raw === 'object' && 'block' in raw) {
    const block = Number((raw as { block: unknown }).block) || 0
    const hash = (raw as unknown as { blockHash: unknown }).blockHash
    return { nextBlock: block, checkpoint: block > 0 && typeof hash === 'string' && hash ? { height: block - 1, hash } : null }
  }
  if (typeof raw === 'number' && raw > 0) return { nextBlock: raw, checkpoint: null }
  return { nextBlock: 0, checkpoint: null }
}

// The cursor is isolated by the (chainId, contract, account) triple (R04:
// switching contracts/chains never shares a cursor)
export const cursorKeyFor = (contract: string, account: string): string =>
  `mailboxCursor:${autoEvmChain.id}:${contract}:${account.toLowerCase()}`

async function loadCursor(contract: string, account: string): Promise<MailboxCursor> {
  const cur = normalizeCursor(await getMeta(cursorKeyFor(contract, account)))
  if (cur.nextBlock > 0) return cur
  // The legacy cursor key held only the address (value = plain block number) —
  // migrated once to the triple key
  const legacy = normalizeCursor(await getMeta<number>(`mailboxCursor:${account.toLowerCase()}`))
  return legacy.nextBlock > 0 ? legacy : { nextBlock: 0, checkpoint: null }
}

// Scan lookback window: rescan a few blocks before the cursor (idempotent
// merge + orphan invalidation, covers shallow reorgs around the cursor write)
const RESCAN_LOOKBACK = 64

/**
 * F04: orphan invalidation — records of this contract/chain inside the rescan
 * window [fromBlock, toBlock] that this canonical scan did not reproduce are
 * reorg orphans; returns the ids to delete. Records without a block number
 * (0/undefined, legacy) never participate in deletion (conservative). Pure
 * function so it can be tested offline.
 */
export function staleMessageIds(
  all: MessageRecord[],
  contract: string,
  chainId: number,
  fromBlock: number,
  toBlock: number,
  seenIds: ReadonlySet<string>,
): string[] {
  const prefix = `${contract}:`
  return all
    .filter(
      (m) =>
        m.id.startsWith(prefix) &&
        (m.chainId ?? 870) === chainId &&
        (m.blockNumber ?? 0) >= fromBlock &&
        (m.blockNumber ?? 0) <= toBlock &&
        !seenIds.has(m.id),
    )
    .map((m) => m.id)
}

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

/** F04: the cursor value after a completed sync — nextBlock = toBlock+1, and
 * the checkpoint records toBlock's OWN height/hash (the same-height pairing is
 * guaranteed by construction; the old code stored toBlock's hash against a
 * toBlock+1 query height, which misdetected a reorg on every healthy sync).
 * Extracted as a pure function so tests can assert the invariant */
export const cursorAfterSync = (toBlock: number, hash: string | null): MailboxCursor => ({
  nextBlock: toBlock + 1,
  checkpoint: toBlock > 0 && hash ? { height: toBlock, hash } : null,
})

async function syncMessagesInner(meLower: string, contract: string, signer: EvmSigner | null): Promise<SyncResult> {
  const deployBlock = loadConfig().mailboxDeployBlock
  let cursor = await loadCursor(contract, meLower)
  if (cursor.nextBlock < deployBlock) cursor = { nextBlock: deployBlock, checkpoint: null }
  // Reorg check (R04/F04): the checkpoint's height and hash are compared at the
  // SAME height — mismatch → rewind the window and rescan (idempotent merge,
  // with orphan deletion as the backstop)
  if (cursor.checkpoint) {
    const cp = cursor.checkpoint
    try {
      const checkpoint = await registryPublicClient().getBlock({ blockNumber: BigInt(cp.height) })
      if (checkpoint.hash.toLowerCase() !== cp.hash.toLowerCase()) {
        cursor = { nextBlock: Math.max(deployBlock, cp.height - RESCAN_LOOKBACK), checkpoint: null }
      }
    } catch {
      // the checkpoint block is no longer readable (deep reorg) — rewind too
      cursor = { nextBlock: Math.max(deployBlock, cp.height - RESCAN_LOOKBACK), checkpoint: null }
    }
  }
  const fromBlock = Math.max(deployBlock, cursor.nextBlock - RESCAN_LOOKBACK)
  const latest = await registryPublicClient().getBlockNumber()
  const toBlock = Number(latest)
  if (toBlock < fromBlock) return { scanned: 0, inbox: 0, outbox: 0, fromBlock, toBlock }

  type MessageSentLog = Awaited<ReturnType<typeof scanChunk>>[number]
  // one scan segment (viem getLogs args are typed by the parseAbiItem event)
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

  // store ciphertexts only; the batch + orphan deletions + cursor commit in one
  // transaction (a failed batch advances nothing, R08)
  const records: Parameters<typeof putMessagesWithCursor>[0] = []
  const seenIds = new Set<string>()
  for (const log of [...inbox, ...outbox]) {
    const args = log.args
    // viem event args can be undefined (anonymous-log convention) — skip incomplete
    if (!args || !args.from || !args.to || !args.content || args.sentAt == null) continue
    const isInbox = inbox.includes(log)
    const id = `${contract}:${Number(args.id)}:${log.transactionHash}`
    seenIds.add(id)
    records.push({
      id,
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
  // F04: old records inside the window that this scan did not reproduce are
  // reorg orphans — deleted in the same transaction
  const staleIds = staleMessageIds(await listMessages(), contract, autoEvmChain.id, fromBlock, toBlock, seenIds)
  // the checkpoint is toBlock itself (height and hash at the same height) —
  // the next sync compares at that same height
  const checkpoint = toBlock > 0 ? await registryPublicClient().getBlock({ blockNumber: latest }).catch(() => null) : null
  await putMessagesWithCursor(
    records,
    cursorKeyFor(contract, meLower),
    cursorAfterSync(toBlock, checkpoint ? String(checkpoint.hash) : null),
    staleIds,
  )

  // local signers can decrypt offline (no user interaction) — decrypt right
  // after sync; injected is left to the UI
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

/** Decrypt one locked/failed message with the current signer; returns the
 * plaintext and persists it, or throws (reason persisted) */
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

/** Decrypt all locked/failed messages addressed to this account (per-message
 * isolation); returns the success count */
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
