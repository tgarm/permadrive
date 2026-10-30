// R07 offline tests (design review): Pacer atomic slot reservation, request
// timeouts, no blind retry for tx writes. Imports the frontend sources directly
// (Node type stripping), zero network dependencies (a local http server).
//   node rpc-pacer-test.mjs

import http from 'node:http'
import assert from 'node:assert'

const { Pacer, RawRpc, PacedHttpProvider, SubmitResultUnknownError } = await import('../../frontend/src/lib/rpc.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// local http server factory: handler(req, res, body) -> { url, close, hits }
function server(handler) {
  const hits = { count: 0 }
  const s = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits.count++
      handler(req, res, body, hits)
    })
  })
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${s.address().port}`
      // the timeout race does not cancel the underlying fetch (the socket stays open) — force-close before server.close
      resolve({ url, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) }), hits })
    })
  })
}

const rpcBody = (result) => JSON.stringify({ jsonrpc: '2.0', id: 1, result })
const rpcError = (code, message) => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } })

// ---- 1. Pacer atomic reservation: 20 concurrent waitTurns, starts spaced >= interval (the old implementation woke together) ----
{
  const pacer = new Pacer(20)
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 20 }, () => pacer.waitTurn()))
  const elapsed = Date.now() - t0
  // 20 staggered slots: the 20th start is about 19x20=380ms; the old burst implementation would take about 20ms
  ok(elapsed >= 360, `20 concurrent waitTurns took ${elapsed}ms >= 360ms (staggered slots, not a burst)`)
  ok(elapsed < 3000, `20 concurrent waitTurns took ${elapsed}ms < 3000ms (no serial stacking)`)
}

// sequential calls unaffected: two waitTurns spaced >= interval
{
  const pacer = new Pacer(30)
  const t0 = Date.now()
  await pacer.waitTurn()
  await pacer.waitTurn()
  const elapsed = Date.now() - t0
  ok(elapsed >= 25, `two sequential waitTurns spaced ${elapsed}ms >= interval`)
}

// ---- 2. request timeout (AbortSignal): a black-holed server releases on time ----
{
  const s = await server(() => {
    /* never respond */
  })
  const rpc = new RawRpc(s.url, { minIntervalMs: 10, maxRetries: 1, timeoutMs: 300 })
  const t0 = Date.now()
  let err = null
  try {
    await rpc.call('system_chain')
  } catch (e) {
    err = e
  }
  ok(err && /request timeout/.test(err.message), `black-holed request timed out in ${Date.now() - t0}ms (${err?.message.slice(0, 60)})`)
  await s.close()
}

// ---- 3. read retries still work: two 503s then success ----
{
  let n = 0
  const s = await server((req, res) => {
    if (++n < 3) {
      res.writeHead(503)
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(rpcBody('flaky-ok'))
    }
  })
  const rpc = new RawRpc(s.url, { minIntervalMs: 10, maxRetries: 5, timeoutMs: 1000 })
  const out = await rpc.call('system_chain')
  ok(out === 'flaky-ok', `read retried with backoff after transient failures (${n} requests)`)
  await s.close()
}

// ---- 4. a black-holed tx write: result unknown, never retried ----
{
  const s = await server(() => {
    /* never respond */
  })
  const provider = new PacedHttpProvider(s.url, { minIntervalMs: 10, maxRetries: 6, timeoutMs: 300 })
  const t0 = Date.now()
  let err = null
  try {
    await provider.send('author_submitExtrinsic', ['0xdead'])
  } catch (e) {
    err = e
  }
  ok(err instanceof SubmitResultUnknownError, `black-holed write -> SubmitResultUnknownError (${Date.now() - t0}ms)`)
  ok(s.hits.count === 1, `exactly 1 write attempt (no resend)`)
  await s.close()
}

// ---- 5. a definitive node rejection (JSON-RPC error with code) rethrows ----
{
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(rpcError(1012, '1012: Transaction is temporarily banned.'))
  })
  const provider = new PacedHttpProvider(s.url, { minIntervalMs: 10, maxRetries: 6, timeoutMs: 1000 })
  let err = null
  try {
    await provider.send('author_submitExtrinsic', ['0xdead'])
  } catch (e) {
    err = e
  }
  ok(err && !(err instanceof SubmitResultUnknownError), 'definitive rejection is not SubmitResultUnknownError')
  ok((err?.code ?? null) === 1012, `the rejection carries code=1012 (${String(err?.message).slice(0, 60)}...)`)
  ok(s.hits.count === 1, `a definitive rejection is not retried`)
  await s.close()
}

// ---- 6. a black-holed read: retries exhaust, then a transport error ----
{
  const s = await server(() => {
    /* never respond */
  })
  const provider = new PacedHttpProvider(s.url, { minIntervalMs: 10, maxRetries: 2, timeoutMs: 200 })
  let err = null
  try {
    await provider.send('system_chain', [])
  } catch (e) {
    err = e
  }
  ok(err && /request timeout/.test(err.message), `black-holed read -> timeout error (gave up after ${s.hits.count} attempts)`)
  ok(s.hits.count === 2, `read retry budget = maxRetries`)
  await s.close()
}

console.log(`\nAll ${passed} assertions passed ✓ (rpc-pacer-test)`)
process.exit(0)
