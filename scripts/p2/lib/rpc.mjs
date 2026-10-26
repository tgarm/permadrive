// JSON-RPC transport layer with pacing and exponential backoff.
// Public RPCs (taurus / mainnet.subspace.foundation) drop connections / return empty
// responses under rapid consecutive requests, so every on-chain call must go through
// here: requests are spaced ≥ minIntervalMs apart; transport-level failures are retried
// with 2^n backoff; JSON-RPC application-level errors are not retried blindly.

import { HttpProvider } from '@polkadot/rpc-provider'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class RpcError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

// Decide whether a retry is worthwhile: transport-level failures (fetch throws / non-200 /
// empty body / bad JSON) are always retried; -32603 (Internal error) in a JSON-RPC error
// may also be node overload, so give it a few attempts; everything else is fatal.
const isTransient = (err) => {
  if (err.transport) return true
  if (err instanceof RpcError && err.code === -32603) return true
  return false
}

export class Pacer {
  constructor(minIntervalMs = 1600) {
    this.minIntervalMs = minIntervalMs
    this.lastStart = 0
  }

  async waitTurn() {
    const gap = Date.now() - this.lastStart
    if (gap < this.minIntervalMs) await sleep(this.minIntervalMs - gap)
    this.lastStart = Date.now()
  }
}

async function fetchOnce(url, method, params) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (e) {
    throw Object.assign(new Error(`transport: ${e.message}`), { transport: true })
  }
  if (!res.ok) {
    throw Object.assign(new Error(`transport: HTTP ${res.status}`), {
      transport: true,
    })
  }
  const text = await res.text().catch(() => '')
  if (!text) {
    throw Object.assign(new Error('transport: empty body'), { transport: true })
  }
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    throw Object.assign(new Error('transport: invalid JSON'), { transport: true })
  }
  if (msg.error) {
    throw new RpcError(msg.error.message ?? 'rpc error', msg.error)
  }
  return msg.result
}

// Bare JSON-RPC client (independent of the polkadot api, for when spinning up an ApiPromise is not wanted)
export class RawRpc {
  constructor(url, { minIntervalMs = 1600, maxRetries = 6 } = {}) {
    this.url = url
    this.pacer = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
  }

  // Batch JSON-RPC (POSTs an array; responses are re-ordered by id)
  async callBatch(requests) {
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
        const byId = new Map(arr.map((r) => [r.id, r]))
        return requests.map((r) => byId.get(r.id))
      } catch (e) {
        const transient = !e.code || e.code === -32603
        if (attempt === 1 || attempt % 3 === 0 || !transient || attempt === this.maxRetries)
          console.warn(`  rpc-batch(${requests.length}) attempt ${attempt}/${this.maxRetries}: ${e.message}`)
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  async call(method, params = []) {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.pacer.waitTurn()
      try {
        return await fetchOnce(this.url, method, params)
      } catch (e) {
        const transient = isTransient(e)
        if (attempt === 1 || attempt % 5 === 0 || !transient || attempt === this.maxRetries)
          console.warn(
            `  rpc ${method} attempt ${attempt}/${this.maxRetries} failed: ${e.message}${transient ? '' : ' (fatal)'}`,
          )
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }
}

// HttpProvider subclass for ApiPromise: every send goes through the same pacer and backoff.
// Public nodes rate-limit by request frequency, so calls the library makes internally
// (init/metadata) need pacing too.
export class PacedHttpProvider extends HttpProvider {
  constructor(url, { minIntervalMs = 1600, maxRetries = 6 } = {}) {
    super(url)
    this.paced = new Pacer(minIntervalMs)
    this.maxRetries = maxRetries
  }

  async send(method, params, isCacheable) {
    let delay = 3000
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.paced.waitTurn()
      try {
        return await super.send(method, params, isCacheable)
      } catch (e) {
        const message = e?.message ?? String(e)
        // Transaction-pool errors are deterministic (banned/invalid/low priority); resubmitting the same tx only makes things worse
        const poolError = /banned|already imported|invalid|priority|too large|exhaust/i.test(message)
        const transient =
          !poolError &&
          (/HTTP|fetch|network|timeout|empty|JSON|abnormal|1006/i.test(message) ||
            e?.code === -32603)
        console.warn(
          `  provider ${method} attempt ${attempt}/${this.maxRetries} failed: ${message}${transient ? '' : ' (fatal)'}`,
        )
        if (!transient || attempt === this.maxRetries) throw e
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }
}
