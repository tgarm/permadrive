// IndexedDB: the local index is keyed by rootCid (cross-device recovery needs
// only the manifest set). Archive status (indexer polling progress) is stored
// separately in tasks, not inside the manifest (the manifest is a
// self-contained shareable unit).
// (v2): the registry mapping table rootCid → {manifestCid, height} — the
// manifest file's publication location is the product of "sync to the on-chain
// registry" and likewise stays out of the manifest itself.
// (v3): notes / vaults stores. Note records keep title + draft + version
// metadata (the authoritative version chain lives in the on-chain registry);
// vault records keep the latest envelope (ciphertext) + version metadata —
// decrypted entries live in memory only and never reach IndexedDB.
// (v4): messages (on-chain mailbox local cache) + meta (kv: the getLogs
// cursor). Received mail is cached as plaintext after decryption; the outbox
// plaintext is local-only by design (not restored on a new device).
// Design-review R03/R04 extend MessageRecord (decrypt status, chain/block
// fields) and R08 reworks the transaction semantics below.

import type { Manifest } from './manifest'
import type { VaultEnvelopeV1 } from './vaultCrypto'

const DB_NAME = 'permadrive'
const DB_VERSION = 4
const MANIFESTS = 'manifests'
const TASKS = 'tasks'
const REGISTRY = 'registry'
const NOTES = 'notes'
const VAULTS = 'vaults'
const MESSAGES = 'messages'
const META = 'meta'

export interface TaskRecord {
  id: string // rootCid
  kind: 'archive-watch'
  fileName: string
  indexed: number
  total: number
  done: boolean
  createdAt: number
  updatedAt: number
}

// ---- publish tasks (design review R02) ----
// Persisted right after signing, before submitting: tx hashes + start height +
// the metadata needed to rebuild the manifest. When the submit result is unknown
// (timeout / lost response / confirm failure), verify by rescanning hashes —
// never auto-resend (a same-nonce resend trips the (signer, nonce) dedup ban).
// Shares the tasks store with archive-watch, ids prefixed 'publish:'.
export interface PublishTaskRecord {
  id: string // 'publish:' + rootCid
  kind: 'publish'
  rootCid: string
  file: { name: string; size: number; sha256: string; mimeType: string | null }
  /** manifest assembly overrides (plaintext metadata + encryption block for encrypted uploads) */
  overridesFile: Record<string, unknown> | null
  encryption: unknown | null
  nodes: { cid: string; blake3: string; bytes: number }[]
  totalBytes: number
  startHeight: number
  txHashes: string[]
  status: 'pending-verify' | 'confirmed'
  lastError: string | null
  createdAt: number
  updatedAt: number
}

// On-chain registry record (local cache: who has custody, and which block the manifest file landed in)
export interface RegistryRecord {
  rootCid: string // rootCid of the file's manifest (primary key, aligned with the manifests store)
  manifestCid: string // root CID of the manifest file (re-published into the DSN)
  height: number // block containing the manifest file's remark
  evmAddress: string // registrant
  syncedAt: number
}

// ---- notes ----

export interface NoteVersionRecord {
  rootCid: string // content file DAG root (= manifests store key, used for retrieval)
  manifestCid: string // root CID of the manifest re-published into the DSN (registry value)
  height: number // block containing the manifest file
  name: string // pdnote-{id}-{slug}.md (grouping convention)
  version: number
  size: number
  savedAt: number
}

export interface NoteRecord {
  id: string
  title: string
  content: string // current local draft (plaintext; never auto-published)
  versions: NoteVersionRecord[]
  createdAt: number
  updatedAt: number
}

// ---- vault ----

export interface VaultVersionRecord {
  rootCid: string // envelope file DAG root (= manifests store key)
  manifestCid: string // root CID of the manifest re-published into the DSN (registry value)
  height: number
  name: string // pdvault-{addr8}.json
  size: number
  savedAt: number
}

export interface VaultRecord {
  address: string // owner EVM address (lowercase, primary key)
  envelope: VaultEnvelopeV1 // latest envelope (ciphertext; plaintext entries never stored)
  versions: VaultVersionRecord[]
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    // R08: an upgrade blocked by an old connection in another tab fails
    // explicitly (no hang forever); this connection yields on versionchange
    req.onblocked = () => reject(new Error('indexedDB upgrade blocked by another tab — close other tabs of this app and retry'))
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(MANIFESTS)) db.createObjectStore(MANIFESTS, { keyPath: 'rootCid' })
      if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(REGISTRY)) db.createObjectStore(REGISTRY, { keyPath: 'rootCid' })
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(VAULTS)) db.createObjectStore(VAULTS, { keyPath: 'address' })
      if (!db.objectStoreNames.contains(MESSAGES)) db.createObjectStore(MESSAGES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      // close this connection when another tab requests an upgrade, so its
      // onblocked never hangs
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('indexedDB open failed'))
    }
  })
  return dbPromise
}

// R08: request.onsuccess does not mean persisted — the transaction can still
// abort (quota / later request failure / explicit abort). Resolve on
// transaction.oncomplete; reject on abort/error.
function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        let result!: T
        t.oncomplete = () => resolve(result)
        t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'))
        t.onerror = () => reject(t.error ?? new Error('indexedDB transaction error'))
        const req = run(t.objectStore(store))
        req.onsuccess = () => {
          result = req.result
        }
      }),
  )
}

// ---- manifests ----

export const listManifests = (): Promise<Manifest[]> => tx<Manifest[]>(MANIFESTS, 'readonly', (s) => s.getAll() as IDBRequest<Manifest[]>)

export const getManifest = (rootCid: string): Promise<Manifest | undefined> =>
  tx<Manifest | undefined>(MANIFESTS, 'readonly', (s) => s.get(rootCid) as IDBRequest<Manifest | undefined>)

export const putManifest = (manifest: Manifest): Promise<void> =>
  tx(MANIFESTS, 'readwrite', (s) => s.put(manifest)).then(() => undefined)

export const deleteManifest = (rootCid: string): Promise<void> =>
  tx(MANIFESTS, 'readwrite', (s) => s.delete(rootCid)).then(() => undefined)

// ---- tasks ----

// The tasks store now holds both archive-watch and publish records (id-prefix
// isolated) — list reads filter by kind so each consumer gets its own shape
export const listTasks = (): Promise<TaskRecord[]> =>
  tx<unknown[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>).then((all) =>
    all.filter((t): t is TaskRecord => (t as { kind?: string }).kind === 'archive-watch'),
  )

export const putTask = (task: TaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deleteTask = (id: string): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- publish tasks (design review R02; shares the tasks store, 'publish:' id prefix) ----

export const listPublishTasks = (): Promise<PublishTaskRecord[]> =>
  tx<unknown[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>).then((all) =>
    all.filter((t): t is PublishTaskRecord => (t as { kind?: string }).kind === 'publish'),
  )

export const putPublishTask = (task: PublishTaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deletePublishTask = (id: string): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- registry mapping ----

export const listRegistryRecords = (): Promise<RegistryRecord[]> =>
  tx<RegistryRecord[]>(REGISTRY, 'readonly', (s) => s.getAll() as IDBRequest<RegistryRecord[]>)

export const putRegistryRecord = (record: RegistryRecord): Promise<void> =>
  tx(REGISTRY, 'readwrite', (s) => s.put(record)).then(() => undefined)

export const getRegistryRecord = (rootCid: string): Promise<RegistryRecord | undefined> =>
  tx<RegistryRecord | undefined>(REGISTRY, 'readonly', (s) => s.get(rootCid) as IDBRequest<RegistryRecord | undefined>)

// ---- notes ----

export const listNotes = (): Promise<NoteRecord[]> => tx<NoteRecord[]>(NOTES, 'readonly', (s) => s.getAll() as IDBRequest<NoteRecord[]>)

export const getNote = (id: string): Promise<NoteRecord | undefined> =>
  tx<NoteRecord | undefined>(NOTES, 'readonly', (s) => s.get(id) as IDBRequest<NoteRecord | undefined>)

export const putNote = (note: NoteRecord): Promise<void> => tx(NOTES, 'readwrite', (s) => s.put(note)).then(() => undefined)

export const deleteNote = (id: string): Promise<void> => tx(NOTES, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- vaults ----

export const listVaults = (): Promise<VaultRecord[]> => tx<VaultRecord[]>(VAULTS, 'readonly', (s) => s.getAll() as IDBRequest<VaultRecord[]>)

export const getVault = (address: string): Promise<VaultRecord | undefined> =>
  tx<VaultRecord | undefined>(VAULTS, 'readonly', (s) => s.get(address.toLowerCase()) as IDBRequest<VaultRecord | undefined>)

export const putVault = (vault: VaultRecord): Promise<void> =>
  tx(VAULTS, 'readwrite', (s) => s.put({ ...vault, address: vault.address.toLowerCase() })).then(() => undefined)

export const deleteVault = (address: string): Promise<void> =>
  tx(VAULTS, 'readwrite', (s) => s.delete(address.toLowerCase())).then(() => undefined)

// ---- messages (P4; R03/R04 extensions) ----

// A message's local record. Inbox records cache the decrypted plaintext
// (plain); outbox (sentByMe) plaintext exists only on the sending machine.
// R03: sync (pull on-chain ciphertext) and decryption are separated —
// decryptStatus tracks each message; failures are retryable singly or in bulk
// (the cursor means "logs persisted", not "decrypted").
// R04: chainId/blockNumber/blockHash recorded (cursor isolated by
// chainId+contract+account).
export interface MessageRecord {
  id: string // composite key `${contract}:${eventId}:${txHash}`
  eventId: number // MessageSent event id (globally increasing)
  from: string // lowercase address
  to: string // lowercase address
  content: string // ciphertext envelope JSON (BoxEnvelope)
  plain: string | null // plaintext cache (inbox after decrypt / outbox at send time)
  at: number // on-chain block timestamp (ms)
  txHash: string
  read: boolean // inbox read marker
  sentByMe: boolean
  chainId?: number // R04: chain dimension (870 today; missing on legacy records)
  blockNumber?: number // R04: inclusion block (reorg audit)
  blockHash?: string | null // R04: inclusion block hash (checkpoint check)
  decryptStatus?: 'ok' | 'locked' | 'failed' // R03: derived from plain on legacy records
  decryptError?: string | null // R03: failure reason (UI display/debug)
}

/** Fill defaults for legacy records (schemaless upgrade: no data migration, normalize on read) */
export function normalizeMessage(m: MessageRecord): MessageRecord {
  return {
    ...m,
    chainId: m.chainId ?? 870,
    blockNumber: m.blockNumber ?? 0,
    blockHash: m.blockHash ?? null,
    decryptStatus: m.decryptStatus ?? (m.plain != null ? 'ok' : 'locked'),
    decryptError: m.decryptError ?? null,
  }
}

/** Idempotent merge (R03/R04): keeps existing non-empty plain and read=true;
 * decrypt status takes the better of the two (ok > failed > locked) — log
 * replays / concurrent scans never wipe plaintext or reset read state */
export function mergeMessage(existing: MessageRecord | undefined, next: MessageRecord): MessageRecord {
  if (!existing) return normalizeMessage(next)
  const rank = { ok: 3, failed: 2, locked: 1 } as const
  const ex = normalizeMessage(existing)
  const nx = normalizeMessage(next)
  const status = rank[nx.decryptStatus!] >= rank[ex.decryptStatus!] ? nx.decryptStatus : ex.decryptStatus
  return {
    ...nx,
    plain: nx.plain ?? ex.plain ?? null,
    read: nx.read || ex.read,
    decryptStatus: status,
    decryptError: status === 'failed' ? (nx.decryptError ?? ex.decryptError ?? null) : null,
    blockNumber: nx.blockNumber || ex.blockNumber,
    blockHash: nx.blockHash ?? ex.blockHash,
  }
}

// kv misc (the getLogs cursor etc.)
export interface MetaRecord {
  key: string
  value: unknown
}

export const listMessages = (): Promise<MessageRecord[]> =>
  tx<MessageRecord[]>(MESSAGES, 'readonly', (s) => s.getAll() as IDBRequest<MessageRecord[]>).then((all) => all.map(normalizeMessage))

// R03/R08: read-merge-write atomically in one transaction (replays/concurrent
// scans preserve plaintext and read state)
export const putMessage = (message: MessageRecord): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(MESSAGES, 'readwrite')
        t.oncomplete = () => resolve()
        t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'))
        t.onerror = () => reject(t.error ?? new Error('indexedDB transaction error'))
        const store = t.objectStore(MESSAGES)
        const getReq = store.get(message.id)
        getReq.onsuccess = () => {
          store.put(mergeMessage(getReq.result as MessageRecord | undefined, message))
        }
      }),
  )

// R08: the message batch and cursor commit in one transaction — a failed batch
// never advances the cursor
export const putMessagesWithCursor = (messages: MessageRecord[], cursorKey: string, cursorValue: unknown): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction([MESSAGES, META], 'readwrite')
        t.oncomplete = () => resolve()
        t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'))
        t.onerror = () => reject(t.error ?? new Error('indexedDB transaction error'))
        const messages_ = t.objectStore(MESSAGES)
        for (const m of messages) {
          const getReq = messages_.get(m.id)
          getReq.onsuccess = () => {
            messages_.put(mergeMessage(getReq.result as MessageRecord | undefined, m))
          }
        }
        t.objectStore(META).put({ key: cursorKey, value: cursorValue } satisfies MetaRecord)
      }),
  )

// read flag (R08: read-modify-write in one transaction, closing the lost-update
// window against concurrent putMessage)
export const markMessageRead = (id: string): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(MESSAGES, 'readwrite')
        t.oncomplete = () => resolve()
        t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'))
        t.onerror = () => reject(t.error ?? new Error('indexedDB transaction error'))
        const store = t.objectStore(MESSAGES)
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const m = getReq.result as MessageRecord | undefined
          if (m && !m.read) store.put({ ...m, read: true })
        }
      }),
  )

/** Decrypt status update (R03: persist success and failure alike, with the reason; per-message isolation) */
export const putMessageDecryptResult = (id: string, plain: string | null, error: string | null): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(MESSAGES, 'readwrite')
        t.oncomplete = () => resolve()
        t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'))
        t.onerror = () => reject(t.error ?? new Error('indexedDB transaction error'))
        const store = t.objectStore(MESSAGES)
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const m = getReq.result as MessageRecord | undefined
          if (m) {
            const status: MessageRecord['decryptStatus'] = plain != null ? 'ok' : 'failed'
            store.put(mergeMessage(m, { ...m, plain: plain != null ? plain : null, decryptStatus: status, decryptError: error }))
          }
        }
      }),
  )

// kv misc (the getLogs cursor etc.)
export interface MetaRecord {
  key: string
  value: unknown
}

// ---- meta (P4: kv misc) ----

export const getMeta = async <T>(key: string): Promise<T | undefined> => {
  const rec = await tx<MetaRecord | undefined>(META, 'readonly', (s) => s.get(key) as IDBRequest<MetaRecord | undefined>)
  return rec?.value as T | undefined
}

export const putMeta = (key: string, value: unknown): Promise<void> =>
  tx(META, 'readwrite', (s) => s.put({ key, value })).then(() => undefined)
