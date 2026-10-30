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
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('indexedDB open failed'))
    }
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
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

export const listTasks = (): Promise<TaskRecord[]> => tx<TaskRecord[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<TaskRecord[]>)

export const putTask = (task: TaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deleteTask = (id: string): Promise<void> =>
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

// ---- messages (P4) ----

// A message's local record. Inbox records cache the decrypted plaintext
// (plain); outbox (sentByMe) plaintext exists only on the sending machine.
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
}

// kv misc (the getLogs cursor etc.)
export interface MetaRecord {
  key: string
  value: unknown
}

export const listMessages = (): Promise<MessageRecord[]> =>
  tx<MessageRecord[]>(MESSAGES, 'readonly', (s) => s.getAll() as IDBRequest<MessageRecord[]>)

export const putMessage = (message: MessageRecord): Promise<void> =>
  tx(MESSAGES, 'readwrite', (s) => s.put(message)).then(() => undefined)

// Read marker (read then write, avoiding full-record overwrite races)
export const markMessageRead = async (id: string): Promise<void> => {
  const m = await tx<MessageRecord | undefined>(MESSAGES, 'readonly', (s) => s.get(id) as IDBRequest<MessageRecord | undefined>)
  if (m && !m.read) await tx(MESSAGES, 'readwrite', (s) => s.put({ ...m, read: true })).then(() => undefined)
}

// ---- meta (P4: kv misc) ----

export const getMeta = async <T>(key: string): Promise<T | undefined> => {
  const rec = await tx<MetaRecord | undefined>(META, 'readonly', (s) => s.get(key) as IDBRequest<MetaRecord | undefined>)
  return rec?.value as T | undefined
}

export const putMeta = (key: string, value: unknown): Promise<void> =>
  tx(META, 'readwrite', (s) => s.put({ key, value })).then(() => undefined)
