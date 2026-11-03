// Offline tests for dynamic batch publishing (2026-11-03): remarks grouped
// by an encoded-size budget, one signature per batch confirmed sequentially.
// "Provably not sent" failures (capacity rejection / gateway 413) can be
// retried / shrunk / aborted interactively, and aborting strips the phantom
// hash; "result unknown" never prompts and never resends (the pooled tx
// occupies the nonce — a smaller replan pays less and cannot usurp it), only
// hash-based rescanning applies. Zero network dependencies.
//   node multi-batch-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

const { publishPrepared, planBatches, estimateBatchCount, listPendingPublish, MAX_BATCH_ENCODED_BYTES, MIN_BATCH_ENCODED_BYTES } = await import('../../frontend/src/lib/publish.ts')
const { TxResultUnknownError, TxNotSentError } = await import('../../frontend/src/lib/chain.ts')
const { SubmitResultUnknownError } = await import('../../frontend/src/lib/rpc.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// ---- 1. planBatches pure function ----
{
  const len = (n) => (i) => n
  // everything fits one group
  const g1 = planBatches([1, 2, 3], len(100), 1000)
  ok(g1.length === 1 && g1[0].length === 3, 'planBatches: single group inside budget')
  // exact fit (100x3=300 <= 300)
  const g2 = planBatches([1, 2, 3], len(100), 300)
  ok(g2.length === 1 && g2[0].length === 3, 'planBatches: exact fit stays one group')
  // overflow splits in two
  const g3 = planBatches([1, 2, 3, 4], len(100), 300)
  ok(g3.length === 2 && g3[0].length === 3 && g3[1].length === 1, 'planBatches: splits at the fill point on overflow')
  // an oversized single item still forms its own group (groups stay non-empty)
  const g4 = planBatches([1, 99], len(100), 50)
  ok(g4.length === 2 && g4[0].length === 1 && g4[1].length === 1, 'planBatches: an oversized item forms its own group')
  // empty input
  ok(planBatches([], len(100), 300).length === 0, 'planBatches: empty input, zero groups')
  // tier constants
  ok(MAX_BATCH_ENCODED_BYTES === 2 * 1024 * 1024, 'MAX_BATCH_ENCODED_BYTES = 2 MiB (mainnet-verified: 2.23 MiB accepted, 4.39 MiB rejected)')
  ok(MIN_BATCH_ENCODED_BYTES === 1024 * 1024, 'MIN_BATCH_ENCODED_BYTES = 1 MiB')
  ok(estimateBatchCount(0) === 1 && estimateBatchCount(1) === 1 && estimateBatchCount(MAX_BATCH_ENCODED_BYTES + 1) === 2, 'estimateBatchCount: floor of 1, rounds up')
}

// ---- mock api (same shape as publish-error-test; parametrized remark encoded length drives batching) ----
const HEAD = 10_000_000
const txRegistry = new Map()
let txCounter = 0
let batchCounter = 0
function mockApi(scenario) {
  const api = {
    scenario,
    rpc: {
      chain: {
        getHeader: async () => ({ number: { toNumber: () => HEAD } }),
        getBlockHash: async (h) => ({ toHex: () => '0x' + BigInt(h).toString(16).padStart(64, '0') }),
        getBlock: async () => ({
          block: {
            extrinsics: scenario.chain.map((h) => txRegistry.get(h) ?? { hash: { toHex: () => h } }),
            header: { parentHash: { toHex: () => '0x' + '11'.repeat(32) }, number: { toNumber: () => HEAD } },
          },
        }),
      },
      author: {
        submitExtrinsic: async (hex) => {
          scenario.submits.push(hex)
          if (scenario.lostAt != null && scenario.submits.length === scenario.lostAt) throw new SubmitResultUnknownError('submit result unknown: transport: request timeout')
          if (scenario.gateway413At != null && scenario.submits.length === scenario.gateway413At) throw new SubmitResultUnknownError('submit result unknown: transport: HTTP 413')
          if (scenario.tooLargeAt != null && scenario.submits.length === scenario.tooLargeAt) throw Object.assign(new Error('Transaction is too large: 2.1 MiB, maximum 10 MiB'), { code: 1012 })
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
        remark: (_payload) => {
          scenario.remarkCalls++
          const hash = `0x01${String(++txCounter).padStart(62, '0')}`
          // same convention as publish-error-test: method structure for on-chain extraction; parametrized length drives batching
          const call = { section: 'system', method: 'remark', args: [new Uint8Array(0)] }
          const tx = {
            hash: { toHex: () => hash },
            encodedLength: scenario.remarkEncodedLength ?? 1024,
            toHex: () => hash,
            signAsync: async () => {},
            method: call,
            args: [new Uint8Array(0)],
          }
          txRegistry.set(hash, tx)
          return tx
        },
      },
      utility: {
        batch: (calls) => mockBatch(scenario, calls, 'batch', '0xad0b'),
        batchAll: (calls) => mockBatch(scenario, calls, 'batchAll', '0xad0c'),
      },
    },
  }
  return api
}
function mockBatch(scenario, calls, kind, prefix) {
  scenario.batchCalls = (scenario.batchCalls ?? 0) + 1
  const hash = `${prefix}${String(++batchCounter).padStart(62, '0')}`
  const innerCalls = calls.map((c) => c.method)
  const call = { section: 'utility', method: kind, args: [innerCalls] }
  const tx = {
    hash: { toHex: () => hash },
    encodedLength: scenario.remarkEncodedLength ?? 1024,
    toHex: () => hash,
    signAsync: async () => {},
    method: call,
    args: [innerCalls],
  }
  txRegistry.set(hash, tx)
  return tx
}

const signer = { kind: 'local', address: '5Htest', pair: { sign: () => {} } }
const onStage = () => {}
const FAST = { scanTimeoutMs: 400, confirmTimeoutMs: 800, depth: 1 }
// content node bytes: real decodable shape (on-chain extraction is not exercised here)
const fakeNode = (i) => ({ cid: `bafk-mb${i}`, blake3: `blake${i}`, bytes: new Uint8Array([1, 2, 3]) })
const prepared = (n, cid = 'bafk-mb-root') => ({
  file: { name: 'test.bin', size: 100, sha256: 'ab'.repeat(32), mimeType: null },
  rootCid: cid,
  nodes: Array.from({ length: n }, (_, i) => fakeNode(i)),
  totalBytes: n * 100,
})

// ---- 2. integration: sequential multi-batch publish (5 remarks x 0.6 MB, 2 MB budget -> 3+2) ----
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 0.6 * 1024 * 1024 }
  const api = mockApi(scenario)
  const titles = []
  const manifest = await publishPrepared(api, prepared(4), signer, onStage, {}, {
    ...FAST,
    recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(90)], totalBytes: 100 },
    confirmTransaction: (submit, batchIndex, totalBatches) => { titles.push([batchIndex, totalBatches]); return submit() },
  })
  ok(scenario.remarkCalls === 5, `2: 5 remark constructions (4 content + 1 recovery), got ${scenario.remarkCalls}`)
  ok(manifest.txs.length === 2, `2: 5x0.6MB under a 2MB budget -> 2 batches (3+2), got ${manifest.txs.length}`)
  ok(scenario.batchCalls === 2, `2: both groups are multi-remark -> batchAll, got ${scenario.batchCalls}`)
  ok(titles.length === 2 && titles[0][0] === 0 && titles[1][0] === 1, '2: wallet actions carry batch indices 0..1')
  ok(titles.every(([, n]) => n === 2), '2: wallet actions carry the batch total 2')
  const pending = await listPendingPublish()
  ok(pending.length === 0, '2: no pending-verify task left after completion')
}

// ---- 3. shrink fallback: batch 1 capacity-rejected -> shrink -> remaining remarks regrouped at the new budget (confirmed batches never resent) ----
// 4 remarks x 0.8 MB: batch 1 (2 remarks) rejected at the 2 MB budget; replanning at 1 MB gives singleton batches
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 0.8 * 1024 * 1024, tooLargeAt: 1 }
  const api = mockApi(scenario)
  const prompts = []
  const manifest = await publishPrepared(api, prepared(3), signer, onStage, {}, {
    ...FAST,
    recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(91)], totalBytes: 100 },
    onChunkFailure: async (info) => {
      prompts.push(info)
      return 'shrink'
    },
  })
  ok(prompts.length === 1 && prompts[0].batchIndex === 0 && prompts[0].totalBatches === 2, `3: batch 1 rejection triggers one prompt (batchIndex=${prompts[0]?.batchIndex})`)
  ok(prompts[0].canShrink === true, '3: shrinkable at the initial budget')
  ok(manifest.txs.length === 4, `3: all 4 remarks on chain after shrink (singleton batches at 1 MB), got ${manifest.txs.length}`)
  ok(scenario.submits.length === 5, `3: 1 rejection + 4 successes, got ${scenario.submits.length}`)
  const pending = await listPendingPublish()
  ok(pending.length === 0, '3: no pending task after the shrink completes')
}

// ---- 4. retry: the same batch re-signed and resubmitted (provably not sent -> safe), succeeding the second time ----
// 2 remarks x 1.5 MB: singleton batches at the 2 MB budget; batch 1 rejected -> retry -> succeeds
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 1.5 * 1024 * 1024, tooLargeAt: 1 }
  const api = mockApi(scenario)
  let prompts = 0
  const manifest = await publishPrepared(api, prepared(1), signer, onStage, {}, {
    ...FAST,
    recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(92)], totalBytes: 100 },
    onChunkFailure: async () => {
      prompts++
      return 'retry'
    },
  })
  ok(prompts === 1, '4: one failure, one prompt')
  ok(manifest.txs.length === 2 && scenario.submits.length === 3, `4: batch 1 retry succeeds + batch 2 normal (${scenario.submits.length} submits)`)
  ok((scenario.batchCalls ?? 0) === 0, '4: singleton batches skip the wrapper; retry reuses the same batch tx (re-signed, not regrouped)')
}

// ---- 5. abort: strip the phantom hash and halt; the task keeps confirmed batches for verification ----
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 1.5 * 1024 * 1024, gateway413At: 2 }
  const api = mockApi(scenario)
  let err = null
  try {
    await publishPrepared(api, prepared(4), signer, onStage, {}, {
      ...FAST,
      recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(93)], totalBytes: 100 },
      onChunkFailure: async () => 'abort',
    })
  } catch (e) {
    err = e
  }
  ok(err instanceof TxNotSentError, `5: gateway 413 -> TxNotSentError (${err?.name})`)
  ok(err.message.includes('HTTP 413'), '5: error message keeps the 413 semantics')
  // batch 1 succeeded (1 tx), batch 2 rejected with 413 -> abort
  const pending = await listPendingPublish()
  ok(pending.length === 1, '5: task retained after halting')
  ok(pending[0].txHashes.length === 1, `5: phantom hash stripped; only confirmed batches kept (${pending[0]?.txHashes.length})`)
  ok(pending[0].txNodes.length === 1 && pending[0].txNodes[0] === 1, '5: txNodes aligned with the confirmed batch (batch 1 = 1 remark singleton)')
}

// ---- 6. result unknown: never prompts, never resends; the task keeps the failed batch hash (may be pooled) ----
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 1.5 * 1024 * 1024, lostAt: 2 }
  const api = mockApi(scenario)
  let prompted = 0
  let err = null
  try {
    await publishPrepared(api, prepared(4), signer, onStage, {}, {
      ...FAST,
      recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(94)], totalBytes: 100 },
      onChunkFailure: async () => {
        prompted++
        return 'retry'
      },
    })
  } catch (e) {
    err = e
  }
  ok(err instanceof TxResultUnknownError, `6: timeout -> TxResultUnknownError (${err?.name})`)
ok(prompted === 0, '6: result-unknown failures never prompt (shrinking would be unsafe)')
  ok(scenario.submits.length === 2, `6: never resent after failure (${scenario.submits.length} submits)`)
  const pending = await listPendingPublish()
  ok(pending.length === 1 && pending[0].txHashes.length === 2, '6: task keeps the failed batch hash (may be pooled; verify by rescan)')
}

// ---- 7. recovery path without onChunkFailure: halts directly even when provably not sent (non-interactive callers) ----
{
  const scenario = { submits: [], chain: [], remarkCalls: 0, remarkEncodedLength: 1.5 * 1024 * 1024, tooLargeAt: 1 }
  const api = mockApi(scenario)
  let err = null
  try {
    await publishPrepared(api, prepared(2), signer, onStage, {}, {
      ...FAST,
      recovery: { rootCid: 'bafk-mb-rec', nodes: [fakeNode(95)], totalBytes: 100 },
    })
  } catch (e) {
    err = e
  }
  ok(err != null && err.name === 'TxRejectedError', `7: capacity rejection rethrown as-is for non-interactive callers (${err?.name})`)
  ok(scenario.submits.length === 1, '7: no resend')
}

console.log(`\nmulti-batch-test: ${passed} passed`)
