// R07 离线测试（doc/13）：Pacer 原子预订、请求超时、写请求不盲重试。
// 直接导入前端源码（Node 26 type stripping），零网络依赖（本地 http server）。
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

// 本地 HTTP server 工厂：handler(req, res, body)；返回 { url, close, hits }
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
      // 超时竞速不会取消底层 fetch（socket 仍连着）—— 关停前强制断开
      resolve({ url, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) }), hits })
    })
  })
}

const rpcBody = (result) => JSON.stringify({ jsonrpc: '2.0', id: 1, result })
const rpcError = (code, message) => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } })

// ---- 1. Pacer 原子预订：并发 20 个 waitTurn，起点间距 ≥ interval（旧实现会同醒齐发）----
{
  const pacer = new Pacer(20)
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 20 }, () => pacer.waitTurn()))
  const elapsed = Date.now() - t0
  // 20 个错峰槽位：第 20 个起点 ≈ 19×20=380ms；同醒齐发的旧实现 ≈ 20ms
  ok(elapsed >= 360, `并发 20 waitTurn 总耗时 ${elapsed}ms ≥ 360ms（槽位错峰，非齐发）`)
  ok(elapsed < 3000, `并发 20 waitTurn 总耗时 ${elapsed}ms < 3000ms（无串行叠加）`)
}

// 顺序调用不受影响：两次 waitTurn 间隔 ≥ interval
{
  const pacer = new Pacer(30)
  const t0 = Date.now()
  await pacer.waitTurn()
  await pacer.waitTurn()
  const elapsed = Date.now() - t0
  ok(elapsed >= 25, `顺序两次 waitTurn 间隔 ${elapsed}ms ≥ interval`)
}

// ---- 2. 请求超时（AbortSignal）：黑洞 server 到期释放，不再永久挂起 ----
{
  const s = await server(() => {
    /* 永不响应 */
  })
  const rpc = new RawRpc(s.url, { minIntervalMs: 10, maxRetries: 1, timeoutMs: 300 })
  const t0 = Date.now()
  let err = null
  try {
    await rpc.call('system_chain')
  } catch (e) {
    err = e
  }
  ok(err && /request timeout/.test(err.message), `黑洞请求 ${Date.now() - t0}ms 内超时释放（${err?.message.slice(0, 60)}）`)
  await s.close()
}

// ---- 3. 读请求退避重试仍然工作：前两次 503，第三次成功 ----
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
  ok(out === 'flaky-ok', `读请求瞬时失败后退避重试成功（${n} 次请求）`)
  await s.close()
}

// ---- 4. 写请求（author_submitExtrinsic）黑洞：结果未知，绝不重试 ----
{
  const s = await server(() => {
    /* 永不响应 */
  })
  const provider = new PacedHttpProvider(s.url, { minIntervalMs: 10, maxRetries: 6, timeoutMs: 300 })
  const t0 = Date.now()
  let err = null
  try {
    await provider.send('author_submitExtrinsic', ['0xdead'])
  } catch (e) {
    err = e
  }
  ok(err instanceof SubmitResultUnknownError, `写请求黑洞 → SubmitResultUnknownError（${Date.now() - t0}ms）`)
  ok(s.hits.count === 1, `写请求失败后仅发出 1 次（未重试重发）`)
  await s.close()
}

// ---- 5. 写请求节点明确拒绝（JSON-RPC 错误响应带 code）：原样上抛，非「结果未知」 ----
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
  ok(err && !(err instanceof SubmitResultUnknownError), '节点明确拒绝 → 非 SubmitResultUnknownError')
  ok((err?.code ?? null) === 1012, `拒绝错误携带 code=1012（${String(err?.message).slice(0, 60)}…）`)
  ok(s.hits.count === 1, `明确拒绝不重试`)
  await s.close()
}

// ---- 6. 读请求黑洞：重试预算耗尽后报传输错误（不无限挂起） ----
{
  const s = await server(() => {
    /* 永不响应 */
  })
  const provider = new PacedHttpProvider(s.url, { minIntervalMs: 10, maxRetries: 2, timeoutMs: 200 })
  let err = null
  try {
    await provider.send('system_chain', [])
  } catch (e) {
    err = e
  }
  ok(err && /request timeout/.test(err.message), `读请求黑洞 → 超时错误（重试 ${s.hits.count} 次后放弃）`)
  ok(s.hits.count === 2, `读请求重试预算 = maxRetries`)
  await s.close()
}

console.log(`\n全部 ${passed} 项通过 ✓（rpc-pacer-test）`)
process.exit(0)
