// Offline tests for the single-shot WS submission of oversized extrinsics
// (2026-11-02): public RPC gateways cap HTTP request bodies at ~15 MB
// (14 MB passes / 16 MB 413, measured), so the ~16.8 MB hex POST of an
// 8 MiB-tier batch always exceeds it — submissions above the threshold go
// over a short-lived single-shot WS connection. Covers: URL derivation,
// threshold decision, single send/receive semantics (JSON-RPC error =
// explicit rejection rethrown as-is; timeout/disconnect = result unknown;
// never auto-retried). Zero network dependencies.
//   node ws-submit-test.mjs

import assert from 'node:assert'

const rpcM = await import('../../frontend/src/lib/rpc.ts')
const { WS_SUBMIT_THRESHOLD_BYTES, useWsSubmit, wsUrlFromHttpUrl, submitRpcOverWs, RpcError, SubmitResultUnknownError } = rpcM

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// ---- URL derivation ----
ok(wsUrlFromHttpUrl('https://rpc.mainnet.subspace.foundation/ws') === 'wss://rpc.mainnet.subspace.foundation/ws', 'https → wss')
ok(wsUrlFromHttpUrl('http://127.0.0.1:9944/ws') === 'ws://127.0.0.1:9944/ws', 'http → ws')
ok(wsUrlFromHttpUrl('wss://rpc.mainnet.autonomys.xyz/ws') === 'wss://rpc.mainnet.autonomys.xyz/ws', 'wss passthrough')

// ---- Threshold decision ----
ok(WS_SUBMIT_THRESHOLD_BYTES === 6 * 1024 * 1024, 'threshold is 6 MiB (HTTP gateway-safe under ~15MB body cap)')
ok(!useWsSubmit(WS_SUBMIT_THRESHOLD_BYTES), 'at threshold → HTTP path')
ok(!useWsSubmit(WS_SUBMIT_THRESHOLD_BYTES - 1), 'below threshold → HTTP path')
ok(useWsSubmit(WS_SUBMIT_THRESHOLD_BYTES + 1), 'above threshold → WS path')

// ---- Single send/receive semantics (fake socket injection) ----
class FakeWs {
  constructor(script) {
    this.script = script
    this.handlers = new Map()
    this.sent = []
    this.closed = false
    this.opened = false
  }
  addEventListener(type, fn) {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }
  emit(type, ev) {
    for (const fn of this.handlers.get(type) ?? []) fn(ev)
  }
  send(data) {
    this.sent.push(data)
    if (this.opened) this.script(this)
  }
  close() {
    this.closed = true
  }
  open() {
    this.opened = true
    this.emit('open', {})
  }
}
const msgEvent = (payload) => ({ data: JSON.stringify(payload) })

// Shared harness: inject the socket and fire open from a microtask once the
// listeners are attached — a real WebSocket's open event also arrives after
// the listeners are in place; the script only runs on sends after open
const runSubmit = (script, { method = 'author_submitExtrinsic', params = ['0xdeadbeef'], ...opts } = {}) => {
  const sockets = []
  const p = submitRpcOverWs('wss://x/ws', method, params, {
    timeoutMs: 5000,
    ...opts,
    makeSocket: (url) => {
      if (opts.expectUrl !== undefined) assert.strictEqual(url, opts.expectUrl)
      const s = new FakeWs(script)
      sockets.push(s)
      return s
    },
  })
  queueMicrotask(() => sockets[0]?.open())
  return { p, sockets }
}

// Success: exactly one send after open, response resolves the result and the socket closes
{
  const { p, sockets } = runSubmit((sock) => {
    sock.emit('message', msgEvent({ jsonrpc: '2.0', id: 1, result: 'ok' }))
  }, { expectUrl: 'wss://x/ws' })
  const result = await p
  ok(result === 'ok', 'WS submit resolves node result')
  ok(sockets[0].sent.length === 1 && sockets[0].sent[0].includes('author_submitExtrinsic') && sockets[0].sent[0].includes('0xdeadbeef'), 'exactly one send carrying method+params')
  ok(sockets[0].closed, 'socket closed after response')
}

// JSON-RPC error = explicit node rejection: RpcError with the code preserved (no retry)
{
  const inner = runSubmit((sock) => {
    sock.emit('message', msgEvent({ jsonrpc: '2.0', id: 1, error: { code: 1012, message: 'Transaction is temporarily banned' } }))
  })
  const err = await inner.p.catch((e) => e)
  ok(err instanceof RpcError && err.code === 1012, 'JSON-RPC error → RpcError with code preserved')
  ok(inner.sockets.length === 1, 'exactly one connection (no retry after explicit rejection)')
}

// Disconnect before a response = result unknown (not a rejection): SubmitResultUnknownError, no retry
{
  const { p, sockets } = runSubmit((sock) => {
    sock.emit('close', { code: 1006 })
  })
  const err = await p.catch((e) => e)
  ok(err instanceof SubmitResultUnknownError, 'close before response → unknown, never retried')
  ok(sockets.length === 1, 'exactly one connection attempt')
}

// Non-JSON frames and id-mismatched frames are ignored; the matching frame still resolves
{
  const { p } = runSubmit((sock) => {
    sock.emit('message', { data: 'not json' })
    sock.emit('message', msgEvent({ jsonrpc: '2.0', id: 7, result: 'other-id' }))
    sock.emit('message', msgEvent({ jsonrpc: '2.0', id: 1, result: 'matched' }))
  })
  const result = await p
  ok(result === 'matched', 'non-matching frames ignored, id-matched frame resolves')
}

// send failure (dead connection) = result unknown
{
  const { p, sockets } = runSubmit(() => {})
  sockets[0].send = () => {
    throw new Error('socket dead')
  }
  const err = await p.catch((e) => e)
  ok(err instanceof SubmitResultUnknownError, 'send failure → unknown')
}

// close after the response: our own close's close event must not pollute a settled promise
{
  const { p } = runSubmit((sock) => {
    sock.emit('message', msgEvent({ jsonrpc: '2.0', id: 1, result: 'ok' }))
  })
  const result = await p
  ok(result === 'ok', 'own close after response does not reject a settled promise')
}

// timeout = result unknown (tiny timeout exercises the timer path and the proactive socket close)
{
  const { p, sockets } = runSubmit(() => {}, { timeoutMs: 50 })
  const err = await p.catch((e) => e)
  ok(err instanceof SubmitResultUnknownError, 'timeout → unknown')
  ok(sockets[0].closed, 'timeout closes the socket')
}

console.log(`\nws-submit-test: ${passed} passed`)
