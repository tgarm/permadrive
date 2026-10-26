// IndexedDB: the local index is keyed by rootCid (cross-device recovery needs
// only the manifest set). Archive status (indexer polling progress) is stored
// separately in tasks, not inside the manifest (the manifest is a
// self-contained shareable unit).
// P2 (v2): the registry mapping table rootCid → {manifestCid, height} — the
// manifest file's publication location is the product of "sync to the on-chain
// registry" and likewise stays out of the manifest itself.

import type { ManifestV1 } from './manifest'

const DB_NAME = 'permadrive'
const DB_VERSION = 2
const MANIFESTS = 'manifests'
const TASKS = 'tasks'
const REGISTRY = 'registry'

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

export const listManifests = (): Promise<ManifestV1[]> => tx<ManifestV1[]>(MANIFESTS, 'readonly', (s) => s.getAll() as IDBRequest<ManifestV1[]>)

export const getManifest = (rootCid: string): Promise<ManifestV1 | undefined> =>
  tx<ManifestV1 | undefined>(MANIFESTS, 'readonly', (s) => s.get(rootCid) as IDBRequest<ManifestV1 | undefined>)

export const putManifest = (manifest: ManifestV1): Promise<void> =>
  tx(MANIFESTS, 'readwrite', (s) => s.put(manifest)).then(() => undefined)

export const deleteManifest = (rootCid: string): Promise<void> =>
  tx(MANIFESTS, 'readwrite', (s) => s.delete(rootCid)).then(() => undefined)

// ---- tasks ----

export const listTasks = (): Promise<TaskRecord[]> => tx<TaskRecord[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<TaskRecord[]>)

export const putTask = (task: TaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deleteTask = (id: string): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- registry mapping (P2) ----

export const listRegistryRecords = (): Promise<RegistryRecord[]> =>
  tx<RegistryRecord[]>(REGISTRY, 'readonly', (s) => s.getAll() as IDBRequest<RegistryRecord[]>)

export const putRegistryRecord = (record: RegistryRecord): Promise<void> =>
  tx(REGISTRY, 'readwrite', (s) => s.put(record)).then(() => undefined)

export const getRegistryRecord = (rootCid: string): Promise<RegistryRecord | undefined> =>
  tx<RegistryRecord | undefined>(REGISTRY, 'readonly', (s) => s.get(rootCid) as IDBRequest<RegistryRecord | undefined>)
