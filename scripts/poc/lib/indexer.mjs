// object-mapping indexer client (the public auto-files-gateway indexer for taurus/mainnet).
// get_object_mappings is queried in batch; if any hash is missing the whole batch errors (the
// official backend behaves the same), so we fall back to per-hash queries; "Object mapping not
// found" is an expected miss, not a failure.
// ⚠️ hash convention: **bare hex, no 0x prefix** (the official dsnFetcher just does
// .toString('hex'); passing a 0x prefix raises no format error — every hash simply comes back
// not found; pitfall measured 2026-10-25)
// Returns Map<hashHex (bare), {pieceIndex, pieceOffset}>.

import WebSocket from 'ws'
import { sleep } from './rpc.mjs'

export class IndexerClient {
  constructor(url, { requestTimeoutMs = 20_000 } = {}) {
    this.url = url
    this.requestTimeoutMs = requestTimeoutMs
    this.ws = null
    this.id = 0
  }

  async #ensureOpen() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.ws?.terminate()
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.ws.terminate()
        reject(new Error('indexer ws connect timeout'))
      }, this.requestTimeoutMs)
      this.ws.once('open', () => {
        clearTimeout(t)
        resolve()
      })
      this.ws.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
    })
  }

  async #request(method, params) {
    await this.#ensureOpen()
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.ws.removeAllListeners('message')
        this.ws.terminate()
        this.ws = null
        reject(new Error('indexer request timeout'))
      }, this.requestTimeoutMs)
      const onMessage = (d) => {
        let msg
        try {
          msg = JSON.parse(d.toString())
        } catch {
          return
        }
        if (msg.id !== id) return
        clearTimeout(t)
        this.ws.off('message', onMessage)
        resolve(msg)
      }
      this.ws.on('message', onMessage)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  // Query a batch of hashes; misses simply do not appear in the result (a 0x prefix on input is normalized away)
  async getObjectMappings(hashHexes) {
    const normalized = hashHexes.map((h) => h.replace(/^0x/, ''))
    const map = new Map()
    let reply
    try {
      reply = await this.#request('get_object_mappings', { hashes: normalized })
      if (reply.error) throw new Error(reply.error.message)
      for (const [hash, pieceIndex, pieceOffset] of reply.result)
        map.set(hash, { pieceIndex, pieceOffset })
      return map
    } catch (e) {
      if (!/not found/i.test(e.message)) throw e
      // The batch contained misses → query one by one
    }
    for (const hash of normalized) {
      if (map.has(hash)) continue
      const one = await this.#request('get_object_mappings', { hashes: [hash] })
      if (one.error) continue // not found and other misses
      const [h, pieceIndex, pieceOffset] = one.result[0]
      map.set(h, { pieceIndex, pieceOffset })
    }
    return map
  }

  // Poll until every hash is indexed (publish → farmer archive → visible on the indexer, on the order of minutes)
  async pollUntilIndexed(hashHexes, { intervalMs = 30_000, timeoutMs = 30 * 60_000, onProgress } = {}) {
    const pending = new Set(hashHexes)
    const found = new Map()
    const deadline = Date.now() + timeoutMs
    let round = 0
    while (pending.size > 0 && Date.now() < deadline) {
      round++
      const batch = [...pending]
      let result = null
      try {
        result = await this.getObjectMappings(batch)
      } catch (e) {
        console.warn(`  indexer round ${round} error: ${e.message}`)
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

  close() {
    this.ws?.close()
  }
}
