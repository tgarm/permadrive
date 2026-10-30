// IndexedDB：本地索引以 rootCid 为主键（doc/04 §三.4 —— 换设备只需 manifest
// 集合即可完整恢复）。archive 状态（indexer 轮询进度）单独存 tasks，不进
// manifest（manifest 是自包含分享单元，格式定稿 doc/04 §四）。
// P2（v2）：registry 映射表 rootCid → {manifestCid, height} —— manifest 文件
// 的发布定位是「同步到链上目录」的产物，同样不进 manifest 本体。
// P3（v3）：notes / vaults 两 store。笔记记录存标题+草稿+版本元数据（版本链
// 权威在链上目录）；vault 记录存最新信封（密文）+ 版本元数据 —— 解锁后的明文
// 条目只在内存，绝不入 IndexedDB。
// P4（v4，批次 B）：messages（链上信箱本地缓存）+ meta（kv：getLogs 游标）。
// 收信解密后的明文缓存本地；发件箱仅本机缓存（换设备发件历史不恢复，doc/12 §四）。

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

// ---- 发布任务（doc/13 R02）----
// 签名后、提交前落盘：交易 hash + 起始高度 + manifest 重建所需元数据。提交
// 结果未知（超时/响应丢失/确认失败）时按 hash 续扫核实，绝不自动重发
//（同 nonce 重发会撞 (signer, nonce) 去重，坑 10）。与 archive-watch 共用
// tasks store，id 用 'publish:' 前缀隔离。
export interface PublishTaskRecord {
  id: string // 'publish:' + rootCid
  kind: 'publish'
  rootCid: string
  file: { name: string; size: number; sha256: string; mimeType: string | null }
  /** manifest 组装覆盖（加密上传时的明文元数据 + encryption 块） */
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

// 链上目录登记记录（本地缓存：谁已托管、manifest 文件在哪个块）
export interface RegistryRecord {
  rootCid: string // 文件 manifest 的 rootCid（主键，与 manifests 表对齐）
  manifestCid: string // manifest 文件（再入 DSN）的 root CID
  height: number // manifest 文件 remark 所在块
  evmAddress: string // 登记者
  syncedAt: number
}

// ---- P3：笔记（doc/10 §一）----

export interface NoteVersionRecord {
  rootCid: string // 内容文件 DAG root（= manifests 表键，取回内容用）
  manifestCid: string // manifest 再入 DSN 的 root CID（Registry 登记值）
  height: number // manifest 文件所在块
  name: string // pdnote-{id}-v{n}-{slug}.md（分组协议串）
  version: number
  size: number
  savedAt: number
}

export interface NoteRecord {
  id: string
  title: string
  content: string // 当前草稿（本地明文；不自动上链）
  versions: NoteVersionRecord[]
  createdAt: number
  updatedAt: number
}

// ---- P3：密码库（doc/10 §二）----

export interface VaultVersionRecord {
  rootCid: string // 信封文件 DAG root（= manifests 表键）
  manifestCid: string // manifest 再入 DSN 的 root CID（Registry 登记值）
  height: number
  name: string // pdvault-{addr8}.json
  size: number
  savedAt: number
}

export interface VaultRecord {
  address: string // 属主 EVM 地址（小写，主键）
  envelope: VaultEnvelopeV1 // 最新信封（密文；明文条目不落盘）
  versions: VaultVersionRecord[]
  createdAt: number
}

// ---- P4: on-chain mailbox (batch B; R03/R04 extensions) ----

// One local message record. Inbox records cache the decrypted plaintext
// (plain); the outbox (sentByMe) holds plaintext only on the sending device.
// R03: sync (pull on-chain ciphertext) and decryption are separated —
// decryptStatus tracks each message; failures are retryable singly or in bulk
// (the cursor means "logs persisted", not "decrypted").
// R04: chainId/blockNumber/blockHash recorded (cursor isolated by
// chainId+contract+account).
export interface MessageRecord {
  id: string // 复合键 `${contract}:${eventId}:${txHash}`（防跨合约/重放歧义）
  eventId: number // MessageSent 事件 id（全局递增）
  from: string // 小写地址
  to: string // 小写地址
  content: string // 密文信封 JSON（BoxEnvelope）
  plain: string | null // 明文缓存（inbox 解密后 / outbox 发送时）
  at: number // 链上块时间戳（ms）
  txHash: string
  read: boolean // inbox 已读标记
  sentByMe: boolean
  chainId?: number // R04：链维度（当前 870；老记录缺失按 870 补）
  blockNumber?: number // R04：所在块（重组排查/审计用）
  blockHash?: string | null // R04：所在块哈希（checkpoint 核对用）
  decryptStatus?: 'ok' | 'locked' | 'failed' // R03：老记录缺失按 plain 推导
  decryptError?: string | null // R03：失败原因（UI 展示/排查）
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

// kv 杂项（getLogs 游标等）
export interface MetaRecord {
  key: string
  value: unknown
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    // R08: an upgrade blocked by an old connection in another tab fails explicitly (no hang forever); this connection yields and closes on versionchange
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
      // close this connection when another tab requests an upgrade, so its onblocked never hangs
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

// tasks store 现在混存 archive-watch 与 publish 两类记录（id 前缀隔离）——
// 列表读取按 kind 过滤，各自的消费者拿各自的形状
export const listTasks = (): Promise<TaskRecord[]> =>
  tx<unknown[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>).then((all) =>
    all.filter((t): t is TaskRecord => (t as { kind?: string }).kind === 'archive-watch'),
  )

export const putTask = (task: TaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deleteTask = (id: string): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- 发布任务（doc/13 R02；与 archive-watch 共用 tasks store，'publish:' 前缀隔离）----

export const listPublishTasks = (): Promise<PublishTaskRecord[]> =>
  tx<unknown[]>(TASKS, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>).then((all) =>
    all.filter((t): t is PublishTaskRecord => (t as { kind?: string }).kind === 'publish'),
  )

export const putPublishTask = (task: PublishTaskRecord): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.put(task)).then(() => undefined)

export const deletePublishTask = (id: string): Promise<void> =>
  tx(TASKS, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- registry 映射（P2）----

export const listRegistryRecords = (): Promise<RegistryRecord[]> =>
  tx<RegistryRecord[]>(REGISTRY, 'readonly', (s) => s.getAll() as IDBRequest<RegistryRecord[]>)

export const putRegistryRecord = (record: RegistryRecord): Promise<void> =>
  tx(REGISTRY, 'readwrite', (s) => s.put(record)).then(() => undefined)

export const getRegistryRecord = (rootCid: string): Promise<RegistryRecord | undefined> =>
  tx<RegistryRecord | undefined>(REGISTRY, 'readonly', (s) => s.get(rootCid) as IDBRequest<RegistryRecord | undefined>)

// ---- notes（P3）----

export const listNotes = (): Promise<NoteRecord[]> => tx<NoteRecord[]>(NOTES, 'readonly', (s) => s.getAll() as IDBRequest<NoteRecord[]>)

export const getNote = (id: string): Promise<NoteRecord | undefined> =>
  tx<NoteRecord | undefined>(NOTES, 'readonly', (s) => s.get(id) as IDBRequest<NoteRecord | undefined>)

export const putNote = (note: NoteRecord): Promise<void> => tx(NOTES, 'readwrite', (s) => s.put(note)).then(() => undefined)

export const deleteNote = (id: string): Promise<void> => tx(NOTES, 'readwrite', (s) => s.delete(id)).then(() => undefined)

// ---- vaults（P3）----

export const listVaults = (): Promise<VaultRecord[]> => tx<VaultRecord[]>(VAULTS, 'readonly', (s) => s.getAll() as IDBRequest<VaultRecord[]>)

export const getVault = (address: string): Promise<VaultRecord | undefined> =>
  tx<VaultRecord | undefined>(VAULTS, 'readonly', (s) => s.get(address.toLowerCase()) as IDBRequest<VaultRecord | undefined>)

export const putVault = (vault: VaultRecord): Promise<void> =>
  tx(VAULTS, 'readwrite', (s) => s.put({ ...vault, address: vault.address.toLowerCase() })).then(() => undefined)

export const deleteVault = (address: string): Promise<void> =>
  tx(VAULTS, 'readwrite', (s) => s.delete(address.toLowerCase())).then(() => undefined)

// ---- messages（P4）----

export const listMessages = (): Promise<MessageRecord[]> =>
  tx<MessageRecord[]>(MESSAGES, 'readonly', (s) => s.getAll() as IDBRequest<MessageRecord[]>).then((all) => all.map(normalizeMessage))

// R03/R08: read-merge-write atomically in one transaction (replays/concurrent scans preserve plaintext and read state)
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

// R08: the message batch and cursor commit in one transaction — a failed batch never advances the cursor
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

// Read flag (R08: read-modify-write in one transaction, closing the lost-update window against concurrent putMessage)
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

// ---- meta（P4：kv 杂项）----

export const getMeta = async <T>(key: string): Promise<T | undefined> => {
  const rec = await tx<MetaRecord | undefined>(META, 'readonly', (s) => s.get(key) as IDBRequest<MetaRecord | undefined>)
  return rec?.value as T | undefined
}

export const putMeta = (key: string, value: unknown): Promise<void> =>
  tx(META, 'readwrite', (s) => s.put({ key, value })).then(() => undefined)
