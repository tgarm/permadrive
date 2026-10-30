// R02 offline tests (design review): the publish error model — "result unknown /
// timeout / declined signing" never degrades to a resend; only a definitive
// capacity rejection downgrades to per-tx; once the task is persisted, rescanning
// by hash recovers the manifest. Runs the REAL chain.ts submitAndWaitConfirmed
// and publish.ts publishPrepared — only the api.rpc/tx surface is mocked.
// IndexedDB via fake-indexeddb. Zero network dependencies.
//   node publish-error-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

const rpcM = await import('../../frontend/src/lib/rpc.ts')
const chainM = await import('../../frontend/src/lib/chain.ts')
const pubM = await import('../../frontend/src/lib/publish.ts')
const storeM = await import('../../frontend/src/lib/store.ts')

const { SubmitResultUnknownError } = rpcM
const { TxNotFoundError, TxRejectedError, TxResultUnknownError } = chainM
const { publishPrepared, verifyPublishTask, dismissPendingPublish, listPendingPublish } = pubM

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// ---- mock api: scenario-driven ----
// HEAD is a fixed huge value → depth satisfied immediately; getBlockHash is
// deterministic per height → the canonical check always passes; a block's
// extrinsics come from scenario.chain.
const HEAD = 10_000_000
function mockApi(scenario) {
  let txCounter = 0
  const api = {
    scenario,
    rpc: {
      chain: {
        getHeader: async () => { const n = scenario.headStep ? (scenario.head = (scenario.head ?? HEAD) + scenario.headStep) : HEAD; return { number: { toNumber: () => n } } },
        getBlockHash: async (h) => ({ toHex: () => '0x' + BigInt(h).toString(16).padStart(64, '0') }),
        getBlock: async (_bh) => ({
          block: { extrinsics: scenario.chain.map((h) => ({ hash: { toHex: () => h } })) },
        }),
      },
      author: {
        submitExtrinsic: async (hex) => {
          scenario.submits.push(hex)
          if (scenario.submitBehavior === 'lost-response') throw new SubmitResultUnknownError('submit result unknown: transport: request timeout')
          if (scenario.submitBehavior === 'banned') throw Object.assign(new Error('1012: Transaction is temporarily banned.'), { code: 1012 })
          if (scenario.submitBehavior === 'too-large' && !scenario.batchRejected) {
            scenario.batchRejected = true
            throw Object.assign(new Error('Transaction is too large: 2.1 MiB, maximum 10 MiB'), { code: 1012 })
          }
          if (scenario.submitBehavior === 'never-included') return undefined // 接受但永不入块
          // mock 约定：fakeTx.toHex() 即返回自身 hash —— 提交成功 = 立即入块
          scenario.chain.push(hex)
          return undefined
        },
      },
      system: {
        accountNextIndex: async () => ({ toNumber: () => 5 }),
        chain: async () => ({ toString: () => 'Subspace Mainnet' }),
      },
    },
    tx: {
      system: {
        remark: (payload) => {
          scenario.remarkCalls++
          const hash = `0x01${String(++txCounter).padStart(62, '0')}`
          scenario.remarkHashes.push(hash)
          return fakeTx(hash, 'remark')
        },
      },
      utility: {
        batch: (calls) => {
          const hash = `0xad0b${'0'.repeat(60)}`
          scenario.batchHash = hash
          return fakeTx(hash, 'batch')
        },
      },
    },
  }
  return api
}

function fakeTx(hash, _tag) {
  // mock 约定：toHex() 返回自身 hash（提交该 hex = 该 hash 交易入块）
  return {
    hash: { toHex: () => hash },
    encodedLength: 1024,
    toHex: () => hash,
    signAsync: async () => {},
  }
}

// The real submitAndWaitConfirmed scans by tx.hash and matches extrinsic hashes;
// the mock's submitExtrinsic pushes the submitted tx hash into scenario.chain to
// simulate instant inclusion. fakeTx.toHex() returns the tx's own hash, so a
// submitted hex IS the hash.

const signer = { kind: 'local', address: '5Htest', pair: { sign: () => {} } }
let cidSeq = 0
const prepared = (nodes = 3, cid = `bafk-sc${++cidSeq}`) => ({
  file: { name: 'test.bin', size: 100, sha256: 'ab'.repeat(32), mimeType: null },
  rootCid: cid,
  nodes: Array.from({ length: nodes }, (_, i) => ({ cid: `cid${i}`, blake3: `blake${i}`, bytes: new Uint8Array(64) })),
  totalBytes: nodes * 100,
})
const onStage = () => {}
const FAST = { scanTimeoutMs: 400, confirmTimeoutMs: 800, depth: 1 }

// ---- S1 节点已接受但响应丢失 → 结果未知，不降级，任务落盘 ----
{
  const scenario = { submitBehavior: 'lost-response', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0 }
  const api = mockApi(scenario)
  let err = null
  try {
    await publishPrepared(api, prepared(), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err instanceof TxResultUnknownError, `S1 lost response -> TxResultUnknownError (${err?.name})`)
  ok(scenario.remarkCalls === 3, `S1 only the batch was built (${scenario.remarkCalls} remark calls, no per-tx fallback)`)
  const pending = await listPendingPublish()
  ok(pending.length === 1 && pending[0].txHashes.length === 1, `S1 publish task persisted (${pending[0]?.txHashes.length} hash)`)
  ok(pending[0]?.status === 'pending-verify', 'S1 task status pending-verify')
}

// ---- S2 提交成功但永不入块 → 扫描超时 TxNotFoundError，不降级 ----
{
  const scenario = { submitBehavior: 'never-included', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0 }
  const api = mockApi(scenario)
  const sc2cid = `bafk-s2-${Date.now()}`
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc2cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err instanceof TxNotFoundError, `S2 confirm timeout -> TxNotFoundError (${err?.name})`)
  ok(err?.txHash?.startsWith('0x'), `S2 error carries the recovery hint txHash (${err?.txHash?.slice(0, 10)}...)`)
  ok(scenario.remarkCalls === 3, `S2 no per-tx fallback`)
  const pending = await listPendingPublish()
  ok(pending.some((p) => p.rootCid === sc2cid), 'S2 task persisted for later verification')
}

// ---- S3 拒签：签名前失败，无任务落盘，不降级 ----
{
  const scenario = { submitBehavior: 'ok', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0, signThrows: true }
  const api = mockApi(scenario)
  const sc3cid = `bafk-s3-${Date.now()}`
  api.tx.system.remark = (payload) => {
    scenario.remarkCalls++
    const hash = `0x01${String(scenario.remarkCalls).padStart(62, '0')}`
    scenario.remarkHashes.push(hash)
    return { hash: { toHex: () => hash }, encodedLength: 1024, toHex: () => '0xf00d01', signAsync: async () => { throw new Error('user rejected signing') } }
  }
  api.tx.utility.batch = () => ({ hash: { toHex: () => '0xad0b' + '0'.repeat(60) }, encodedLength: 1024, toHex: () => '0xad0b01', signAsync: async () => { throw new Error('user rejected signing') } })
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc3cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err && /rejected/.test(err.message), `S3 signing rejection surfaces (${String(err?.message).slice(0, 40)})`)
  const pending = await listPendingPublish()
  ok(!pending.some((p) => p.rootCid === sc3cid), `S3 pre-signing failure: no task persisted for this scenario (earlier scenarios not counted)`)
}

// ---- S4 batch 明确容量拒绝 → 降级逐笔并全部确认 ----
{
  const scenario = { submitBehavior: 'too-large', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0 }
  const api = mockApi(scenario)
  const sc4cid = `bafk-s4-${Date.now()}`
  let manifest = null
  try {
    manifest = await publishPrepared(api, prepared(3, sc4cid), signer, onStage, {}, FAST)
  } catch (e) {
    console.error('S4 unexpected:', e)
  }
  ok(manifest !== null, 'S4 capacity rejection degraded to per-tx successfully')
  ok(manifest?.txs?.length === 3, `S4 manifest holds 3 per-tx transactions (${manifest?.txs?.length})`)
  ok(scenario.remarkCalls === 6, `S4 6 remark calls (3 batch + 3 per-tx)`)
  ok(scenario.batchRejected === true, 'S4 batch-rejected flag hit')
  const pending = await listPendingPublish()
  ok(!pending.some((p) => p.rootCid === sc4cid), 'S4 recovery task cleaned up after full confirmation')
  ok(manifest?.network === 'mainnet', `S4 network identified as mainnet`)
}

// ---- S5 banned 拒绝 → 不降级（同交易可能在池中），任务落盘 ----
{
  const scenario = { submitBehavior: 'banned', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0 }
  const api = mockApi(scenario)
  const sc5cid = `bafk-s5-${Date.now()}`
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc5cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err instanceof TxRejectedError, `S5 banned -> TxRejectedError (${err?.name})`)
  ok(scenario.remarkCalls === 3, `S5 no per-tx fallback (resending would worsen the ban)`)
  const pending = await listPendingPublish()
  ok(pending.filter((p) => p.rootCid === sc5cid).length === 1, `S5 task kept (the batch hash is the verification handle)`)
}

// ---- S6 按任务 hash 续扫恢复 manifest（交易已上链场景） ----
{
  const pending = await listPendingPublish()
  const record = pending.find((p) => p.rootCid?.startsWith('bafk-s5'))
  // 模拟交易此后入块：把 S5 落盘的 batch hash 塞进链
  const api = mockApi({ submitBehavior: 'ok', submits: [], chain: record.txHashes.slice(), remarkCalls: 0, remarkHashes: [], chainPushIdx: 0, headStep: 1 })
  const manifest = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  ok(manifest !== null, 'S6 rescan found every tx and recovered the manifest')
  ok(manifest?.rootCid === record.rootCid && manifest?.nodes?.length === 3, `S6 manifest rebuilt from task metadata (rootCid/nodes)`)
  ok(manifest?.txs?.length === 1 && manifest.txs[0].txHash === record.txHashes[0], `S6 txs record the verified inclusion`)
  ok(!(await listPendingPublish()).some((p) => p.rootCid === record.rootCid), 'S6 task cleaned up after successful recovery')
}

// ---- S7 续扫仍未找到 → 返回 null，任务保留 ----
{
  const scenario = { submitBehavior: 'never-included', submits: [], chain: [], remarkCalls: 0, remarkHashes: [], chainPushIdx: 0 }
  scenario.headStep = 1
  const api = mockApi(scenario)
  const sc7cid = `bafk-s7-${Date.now()}`
  let err = null
  try {
    await publishPrepared(api, prepared(1, sc7cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err instanceof TxNotFoundError, `S7 create a pending task (${err?.name})`)
  const pending = await listPendingPublish()
  const record = pending.find((p) => p.rootCid === sc7cid)
  const got = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  ok(got === null, 'S7 not found on-chain -> null (result still undetermined)')
  ok((await listPendingPublish()).some((p) => p.id === record.id), 'S7 task kept for the next verification attempt')
  await dismissPendingPublish(record)
  ok(!(await listPendingPublish()).some((p) => p.id === record.id), 'S7 task removed after dismissal')
}

console.log(`\n全部 ${passed} 项通过 ✓（publish-error-test）`)
process.exit(0)
