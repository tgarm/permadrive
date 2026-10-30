// JSON-RPC transport with throttling and exponential backoff (ported from
// scripts/poc/lib/rpc.mjs).
// Under continuous requests the public mainnet RPC returns empty responses /
// SSL EOF, and in the worst case IP-level bans lasting 30+ minutes, so every
// on-chain call must go through here: requests are spaced ≥ minIntervalMs
// apart (atomically reserved slots), transport failures retry with 2^n backoff,
// and JSON-RPC application errors / tx-pool errors are never retried blindly.
// R07 (design review): requests carry an AbortSignal timeout (black-holed
// connections no longer hang forever); a failed tx-write method
// (author_submitExtrinsic) always surfaces as "result unknown" and is never
// auto-resent.

import { HttpProvider } from '@polkadot/rpc-provider'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class RpcError extends Error {
  code?: number
  data?: unknown
  constructor(message: string, { code, data }: { code?: number; data?: unknown } = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/** A failed tx-write request (disconnect/timeout/empty response) — the node may
 * have received and executed it; callers must treat it as "submit result
 * unknown" (verify by scanning for the hash) and must not resend */
export class SubmitResultUnknownError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'SubmitResultUnknownError'
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

interface TransportError extends Error {
  transport: boolean
}

const transportError = (message: string): TransportError =>
  Object.assign(new Error(message), { transport: true }) as TransportError

const isTransient = (err: unknown): boolean => {
  const e = err as TransportError & RpcError
  if (e?.transport) return true
  if (err instanceof RpcError && err.code === -32603) return true
  return false
}

export class Pacer {
  minIntervalMs: number
  private lastStart = 0

  constructor(minIntervalMs = 1600) {
    this.minIntervalMs = minIntervalMs
  }

  // Atomically reserve the next slot (design review R07): compute + write
  // lastStart in one synchronous step so N concurrent callers each get a start
  // spaced ≥ minIntervalMs apart — instead of all reading the same lastStart,
  // waking together and firing concurrently.
  async waitTurn(): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, this.lastStart + this.minIntervalMs)
    this.lastStart = start
    if (start > now) await sleep(start - now)
  }
}

// Per-request hard timeout via AbortSignal: black-holed connections release on time, making upper-layer retries/deadlines meaningful
const REQUEST_TIMEOUT_MS = 30_000

async function postJson(url: string, body: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
  } catch (e) {
    if (ctrl.signal.aborted) throw transportError(`transport: request timeout after ${timeoutMs}ms`)
    throw transportError(`transport: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOnce(url: string, method: string, params: unknown[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  let res: Response
  try {
    res = await postJson(url, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeoutMs)
  } catch (e) {
    throw transportError((e as Error).message)
  }
  if (!res.ok) throw transportError(`transport: HTTP ${res.status}`)
  // an abort after the response headers errors the body stream — classified as transport too
  const text = await res.text().catch(() => '')
  if (!text) throw transportError('transport: empty body')
  let msg: { result?: unknown; error?: { message?: string; code?: number; data?: unknown } }
  try {
    msg = JSON.parse(text)
  } catch {
    throw transportError('transport: invalid JSON')
  }
  if (msg.error) throw new RpcError(msg.error.message ?? 'rpc error', msg.error)
  return msg.result
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown[]
}

// Bare JSON-RPC client (when no ApiPromise is needed)
export class RawRpc {
  url: string
  pacer: Pacer
  maxRetries: number
  timeoutMs: number

  constructor(url: string, { minIntervalMs = 1600, maxRetries = 6, timeoutMs = REQUEST_TIMEOUT_MS }: { minIntervalMs?: number; maxRetries?: number; timeoutMs?: number } = {}) {
    this.url = url
    this.pacer = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
    this.timeoutMs = timeoutMs
  }

  // 批量 JSON-RPC（数组 POST；响应按 id 还原顺序，未命中为 undefined）
  async callBatch(requests: JsonRpcRequest[]): Promise<({ id: number; result?: unknown; error?: unknown } | undefined)[]> {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.pacer.waitTurn()
      try {
        const res = await postJson(this.url, JSON.stringify(requests), this.timeoutMs)
        if (!res.ok) throw new Error(`transport: HTTP ${res.status}`)
        const text = await res.text().catch(() => '')
        if (!text) throw new Error('transport: empty body')
        const arr = JSON.parse(text)
        if (!Array.isArray(arr)) throw new Error('transport: non-batch reply')
        const byId = new Map<number, unknown>(arr.map((r: { id: number }) => [r.id, r]))
        return requests.map((r) => byId.get(r.id) as { id: number } | undefined)
      } catch (e) {
        const transient = !(e instanceof RpcError) || e.code === -32603
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
    throw new Error('unreachable')
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.pacer.waitTurn()
      try {
        return await fetchOnce(this.url, method, params, this.timeoutMs)
      } catch (e) {
        const transient = isTransient(e)
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
    throw new Error('unreachable')
  }
}

// Tx-write methods: a failed send may mean the node already received the
// transaction (a lost response ≠ not submitted). Resending risks the
// (signer, nonce) dedup ban — write failures always surface as "result
// unknown" and are never auto-retried.
const WRITE_METHODS = new Set(['author_submitExtrinsic', 'author_submitAndWatchExtrinsic', 'author_pendingExtrinsics'])

// HttpProvider subclass for ApiPromise: every send goes through the same pacer
// and backoff. Library-internal calls (init/metadata) need the throttling too,
// otherwise the public node rate-limits.
export class PacedHttpProvider extends HttpProvider {
  private paced: Pacer
  private maxRetries: number
  private timeoutMs: number

  constructor(url: string, { minIntervalMs = 1600, maxRetries = 6, timeoutMs = REQUEST_TIMEOUT_MS }: { minIntervalMs?: number; maxRetries?: number; timeoutMs?: number } = {}) {
    super(url)
    this.paced = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
    this.timeoutMs = timeoutMs
  }

  // polkadot's HttpProvider fetch has no timeout of its own (black-hole hangs) —
  // race a timer: on timeout only the wait is abandoned (the underlying
  // connection cannot be cancelled from outside) and classified as transport error
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(transportError(`transport: request timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
      p.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e) => { clearTimeout(timer); reject(e) },
      )
    })
  }

  override async send<T>(method: string, params: unknown[], isCacheable?: boolean): Promise<T> {
    const isWrite = WRITE_METHODS.has(method)
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.paced.waitTurn()
      try {
        return await this.withTimeout(super.send<T>(method, params, isCacheable))
      } catch (e) {
        if (isWrite) {
          // an error carrying a numeric code = the node's JSON-RPC error response
          // (a definitive rejection, incl. pool rejections; the shape of
          // polkadot's provider RpcError) — rethrow for upper-layer classification.
          // Anything else (timeout/disconnect/empty/HTTP != 200) = "submit result
          // unknown"; never auto-resent (lost response ≠ not submitted, and
          // resending the same nonce risks the dedup ban)
          if (typeof (e as { code?: unknown })?.code === 'number') throw e
          throw new SubmitResultUnknownError(`submit result unknown: ${(e as Error)?.message ?? String(e)}`, { cause: e })
        }
        const message = (e as Error)?.message ?? String(e)
        // tx-pool errors are deterministic (banned/invalid/over-limit); resending only makes it worse
        const poolError = /banned|already imported|invalid|priority|too large|exhaust/i.test(message)
        const transient =
          !poolError &&
          (/HTTP|fetch|network|timeout|empty|JSON|abnormal|1006/i.test(message) || (e as { code?: number }).code === -32603)
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
    throw new Error('unreachable')
  }
}
