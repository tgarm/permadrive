// JSON-RPC transport with throttling and exponential backoff (ported from
// scripts/poc/lib/rpc.mjs).
// Under continuous requests the public mainnet RPC returns empty responses /
// SSL EOF, and in the worst case IP-level bans lasting 30+ minutes, so every
// on-chain call must go through here: requests are spaced ≥ minIntervalMs
// apart and transport failures retry with 2^n backoff; JSON-RPC application
// errors and tx-pool errors are never retried blindly.

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

  async waitTurn(): Promise<void> {
    const gap = Date.now() - this.lastStart
    if (gap < this.minIntervalMs) await sleep(this.minIntervalMs - gap)
    this.lastStart = Date.now()
  }
}

async function fetchOnce(url: string, method: string, params: unknown[]): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (e) {
    throw transportError(`transport: ${(e as Error).message}`)
  }
  if (!res.ok) throw transportError(`transport: HTTP ${res.status}`)
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

// Bare JSON-RPC client (for cases that do not spin up an ApiPromise)
export class RawRpc {
  url: string
  pacer: Pacer
  maxRetries: number

  constructor(url: string, { minIntervalMs = 1600, maxRetries = 6 }: { minIntervalMs?: number; maxRetries?: number } = {}) {
    this.url = url
    this.pacer = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
  }

  // Batch JSON-RPC (array POST; the reply is reassembled by id, misses are undefined)
  async callBatch(requests: JsonRpcRequest[]): Promise<({ id: number; result?: unknown; error?: unknown } | undefined)[]> {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.pacer.waitTurn()
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requests),
        })
        if (!res.ok) throw new Error(`transport: HTTP ${res.status}`)
        const text = await res.text()
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
        return await fetchOnce(this.url, method, params)
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

// HttpProvider subclass for ApiPromise: every send goes through the same
// throttle and backoff. Calls the library issues internally (init/metadata)
// need the same throttling, otherwise the public node's rate limiting kicks in.
export class PacedHttpProvider extends HttpProvider {
  private paced: Pacer
  private maxRetries: number

  constructor(url: string, { minIntervalMs = 1600, maxRetries = 6 }: { minIntervalMs?: number; maxRetries?: number } = {}) {
    super(url)
    this.paced = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
  }

  override async send<T>(method: string, params: unknown[], isCacheable?: boolean): Promise<T> {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.paced.waitTurn()
      try {
        return await super.send<T>(method, params, isCacheable)
      } catch (e) {
        const message = (e as Error)?.message ?? String(e)
        // Tx-pool errors are deterministic (banned/invalid/oversized); resending
        // the same tx only makes things worse
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
