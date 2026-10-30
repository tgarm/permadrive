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
import { loadConfig } from './config'
import { fromHex } from './bytes.ts'
import { MAILBOX_ABI } from './mailbox-abi'
import { accountOf, registryPublicClient, walletClientFor, waitWritten } from './registry'
import { autoEvmChain } from './evm'
import { boxDecryptWithSecretKey, boxEncrypt, injectedDecrypt, injectedEncryptionPublicKey, localBoxKeypair, parseEnvelope, serializeEnvelope } from './boxCrypto.ts'
import { getMeta, putMessage, putMeta } from './store'
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
  })
  return { txHash: hash, eventId }
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// Decode the MessageSent event id (topics[1])
function decodeEventId(log: { topics: readonly `0x${string}`[] } | undefined): number {
  if (!log || !log.topics[1]) return -1
  return Number(BigInt(log.topics[1]))
}

// ---- Receiving (getLogs + cursor) ----

export interface SyncResult {
  scanned: number
  inbox: number
  outbox: number
  fromBlock: number
  toBlock: number
}

/**
 * Scan new messages into the local store: cursor (deployment block if absent)
// → latest, in chunks; inbox messages are decrypted and cached (no signer →
 * plain stays null, shown locked); the outbox plaintext was cached at send
 * time — this only backfills ciphertext shells. Idempotent: duplicates are
 * overwritten by composite key, plaintext is preserved.
 */
export async function syncMessages(me: string, signer: EvmSigner | null): Promise<SyncResult> {
  const meLower = me.toLowerCase()
  const contract = mailboxAddress().toLowerCase()
  const cursorKey = `mailboxCursor:${meLower}`
  const deployBlock = loadConfig().mailboxDeployBlock
  const cursor = (await getMeta<number>(cursorKey)) ?? deployBlock
  const latest = await registryPublicClient().getBlockNumber()
  const toBlock = Number(latest)
  if (toBlock < cursor) return { scanned: 0, inbox: 0, outbox: 0, fromBlock: cursor, toBlock }

  type MessageSentLog = Awaited<ReturnType<typeof scanChunk>>[number]
  // The chunk scan is extracted so viem's getLogs args typing flows through (parseAbiItem event)
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
  for (let start = cursor; start <= toBlock; start += SCAN_CHUNK) {
    const end = Math.min(start + SCAN_CHUNK - 1, toBlock)
    const logs = await scanChunk(start, end)
    for (const log of logs) {
      const args = log.args
      if (args.from?.toLowerCase() === meLower) outbox.push(log)
      else if (args.to?.toLowerCase() === meLower) inbox.push(log)
    }
  }

  let secret: Uint8Array | null = null
  if (signer?.kind === 'local') secret = (await localKeypairFor(signer)).secretKey

  let inboxCount = 0
  for (const log of [...inbox, ...outbox]) {
    const args = log.args
    // viem event args can be undefined (anonymous-log semantics) — skip incomplete ones
    if (!args || !args.from || !args.to || !args.content || args.sentAt == null) continue
    const isInbox = inbox.includes(log)
    let plain: string | null = null
    if (secret) {
      try {
        plain = new TextDecoder().decode(boxDecryptWithSecretKey(parseEnvelope(args.content), secret))
      } catch {
        plain = null // decryption failed (e.g. different keypair) → stays locked
      }
    } else if (signer?.kind === 'injected' && signer.provider && isInbox) {
      try {
        plain = new TextDecoder().decode(await injectedDecrypt(signer.provider, signer.address, args.content))
      } catch {
        plain = null // wallet refused/unsupported → stays locked
      }
    }
    await putMessage({
      id: `${contract}:${Number(args.id)}:${log.transactionHash}`,
      eventId: Number(args.id),
      from: args.from.toLowerCase(),
      to: args.to.toLowerCase(),
      content: args.content,
      plain,
      at: Number(args.sentAt) * 1000,
      txHash: log.transactionHash,
      read: !isInbox,
      sentByMe: !isInbox,
    })
    if (isInbox) inboxCount++
  }
  await putMeta(cursorKey, toBlock + 1)
  return { scanned: inbox.length + outbox.length, inbox: inboxCount, outbox: outbox.length, fromBlock: cursor, toBlock }
}
