// object-mapping indexer client (the auto-files-gateway public indexer, browser-native WebSocket).
// get_object_mappings queries in batch; if any hash is missing the whole batch
// errors (same as the official backend), so it falls back to per-hash queries;
// "Object mapping not found" is an expected miss, not a failure.
// ⚠️ hash convention: bare hex, no 0x prefix (known pitfall — passing a 0x
// prefix does not raise a format error, it just always returns not found).
// Inputs are normalized here uniformly.

import { sleep } from './rpc'

export interface ObjectLocation {
  pieceIndex: number
  pieceOffset: number
}

interface PendingRequest {
  resolve: (msg: { result?: unknown; error?: { message: string } }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class IndexerClient {
  url: string
  requestTimeoutMs: number
  private ws: WebSocket | null = null
  private idCounter = 0
  private pending = new Map<number, PendingRequest>()

  constructor(url: string, { requestTimeoutMs = 20_000 }: { requestTimeoutMs?: number } = {}) {
    this.url = url
    this.requestTimeoutMs = requestTimeoutMs
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private async ensureOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.ws?.close()
    this.ws = null
    const ws = new WebSocket(this.url)
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message: string } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id == null) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg)
    }
    ws.onerror = () => {
      this.failAll(new Error('indexer ws error'))
      this.ws = null
    }
    ws.onclose = () => {
      this.failAll(new Error('indexer ws closed'))
      this.ws = null
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('indexer ws connect timeout'))
        ws.close()
      }, this.requestTimeoutMs)
      ws.onopen = () => {
        clearTimeout(t)
        this.ws = ws
        resolve()
      }
      const onError = () => {
        clearTimeout(t)
        reject(new Error('indexer ws connect failed'))
      }
      ws.addEventListener('error', onError, { once: true })
    })
  }

  private async request(method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
    await this.ensureOpen()
    const id = ++this.idCounter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.ws?.close()
        this.ws = null
        reject(new Error('indexer request timeout'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  // Query a batch of hashes; misses do not appear in the result
  async getObjectMappings(hashHexes: string[]): Promise<Map<string, ObjectLocation>> {
    const normalized = hashHexes.map((h) => h.replace(/^0x/, ''))
    const map = new Map<string, ObjectLocation>()
    let reply: { result?: [string, number, number][]; error?: { message: string } }
    try {
      reply = (await this.request('get_object_mappings', { hashes: normalized })) as {
        result?: [string, number, number][]
        error?: { message: string }
      }
      if (reply.error) throw new Error(reply.error.message)
      for (const [hash, pieceIndex, pieceOffset] of reply.result ?? [])
        map.set(hash, { pieceIndex, pieceOffset })
      return map
    } catch (e) {
      if (!/not found/i.test((e as Error).message)) throw e
      // Missing hashes in the batch → query one by one
    }
    for (const hash of normalized) {
      if (map.has(hash)) continue
      const one = (await this.request('get_object_mappings', { hashes: [hash] })) as {
        result?: [string, number, number][]
        error?: { message: string }
      }
      if (one.error) continue // expected miss such as not found
      const [h, pieceIndex, pieceOffset] = (one.result ?? [])[0]
      if (h != null) map.set(h, { pieceIndex, pieceOffset })
    }
    return map
  }

  // Poll until every hash is indexed (publish → farmer archive → indexer queryable,
  // measured at 100 s to 2 h)
  async pollUntilIndexed(
    hashHexes: string[],
    { intervalMs = 30_000, timeoutMs = 30 * 60_000, signal, onProgress }: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onProgress?: (found: number, total: number, round: number) => void } = {},
  ): Promise<{ found: Map<string, ObjectLocation>; pending: string[] }> {
    const pending = new Set(hashHexes)
    const found = new Map<string, ObjectLocation>()
    const deadline = Date.now() + timeoutMs
    let round = 0
    while (pending.size > 0 && Date.now() < deadline) {
      if (signal?.aborted) break
      round++
      let result: Map<string, ObjectLocation> | null = null
      try {
        result = await this.getObjectMappings([...pending])
      } catch {
        // A ws failure during polling is not fatal; reconnect and retry next round
      }
      if (result) {
        for (const [hash, loc] of result) {
          pending.delete(hash)
          found.set(hash, loc)
        }
        onProgress?.(found.size, hashHexes.length, round)
      }
      if (pending.size > 0) await sleep(intervalMs)
    }
    return { found, pending: [...pending] }
  }

  close(): void {
    this.failAll(new Error('indexer closed'))
    this.ws?.close()
    this.ws = null
  }
}
