// R02 offline tests (design review): the publish error model — "result unknown /
// timeout / declined signing" never degrades to a resend; only a definitive
// capacity rejection downgrades to per-tx; once the task is persisted, rescanning
// by hash recovers the manifest.
// Second review (F02/F03): a partial per-tx publish is never mistaken for
// a complete recovery (txNodes coverage plan + on-chain extraction comparison;
// empty hashes refuse to complete); the manifest and the task deletion commit
// atomically in one IndexedDB transaction.
// Runs the REAL chain.ts submitAndWaitConfirmed and publish.ts publishPrepared —
// only the api.rpc/tx surface is mocked. IndexedDB via fake-indexeddb. Zero
// network dependencies.
//   node publish-error-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

const rpcM = await import('../../frontend/src/lib/rpc.ts')
const chainM = await import('../../frontend/src/lib/chain.ts')
const dagM = await import('../../frontend/src/lib/dag.ts')
const pubM = await import('../../frontend/src/lib/publish.ts')
const storeM = await import('../../frontend/src/lib/store.ts')
const { compactStripLength } = await import('@polkadot/util')

const { SubmitResultUnknownError } = rpcM
const { TxNotFoundError, TxRejectedError, TxResultUnknownError } = chainM
const { publishPrepared, verifyPublishTask, dismissPendingPublish, listPendingPublish } = pubM
const { makeRemarkPayload, tryDecodeRemark } = dagM

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
// F02 coverage semantics: fakeTxs carry a real method structure (polkadot-js
// decode semantics — args[0] holds the node bytes WITHOUT the compact prefix),
// so the on-chain extraction goes through the real tryDecodeRemark.
const HEAD = 10_000_000
// global tx registry: hash → fakeTx (with method structure). Shared across
// scenarios so "the task persisted in S5, rescanned in S6 with a fresh api"
// can restore the block content from the registry.
const txRegistry = new Map()
let txCounter = 0
let batchCounter = 0
function mockApi(scenario) {
  const api = {
    scenario,
    rpc: {
      chain: {
        getHeader: async () => { const n = scenario.headStep ? (scenario.head = (scenario.head ?? HEAD) + scenario.headStep) : HEAD; return { number: { toNumber: () => n } } },
        getBlockHash: async (h) => ({ toHex: () => '0x' + BigInt(h).toString(16).padStart(64, '0') }),
        getBlock: async (_bh) => ({
          block: {
            extrinsics: scenario.chain.map((h) => txRegistry.get(h) ?? { hash: { toHex: () => h } }),
            // extractRemarkNodes reads header.parentHash/number (F02 extraction path)
            header: { parentHash: { toHex: () => '0x' + '11'.repeat(32) }, number: { toNumber: () => HEAD } },
          },
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
          if (scenario.rejectAt != null && scenario.submits.length - 1 === scenario.rejectAt) {
            throw Object.assign(new Error('1010: Invalid Transaction: bad format'), { code: 1010 })
          }
          if (scenario.submitBehavior === 'never-included') return undefined // accepted but never included
          // mock convention: fakeTx.toHex() IS the tx hash — a successful submit includes it instantly
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
          // polkadot-js decode convention: a block's ex.args[0] holds the inner
          // bytes without the compact prefix (top-level .args mirrors
          // .method.args — chain.ts collectRemarkNodes reads the top level)
          const inner = compactStripLength(payload)[1]
          const call = { section: 'system', method: 'remark', args: [inner] }
          const tx = {
            hash: { toHex: () => hash },
            encodedLength: 1024,
            toHex: () => hash,
            signAsync: async () => { if (scenario.rejectSign) throw new Error('user rejected signing') },
            method: call,
            args: [inner],
          }
          txRegistry.set(hash, tx)
          return tx
        },
      },
      utility: {
        batch: (calls) => {
          const hash = `0xad0b${String(++batchCounter).padStart(62, '0')}`
          const innerCalls = calls.map((c) => c.method)
          const call = { section: 'utility', method: 'batch', args: [innerCalls] }
          const tx = {
            hash: { toHex: () => hash },
            encodedLength: 1024,
            toHex: () => hash,
            signAsync: async () => { if (scenario.rejectSign) throw new Error('user rejected signing') },
            method: call,
            args: [innerCalls],
          }
          txRegistry.set(hash, tx)
          return tx
        },
      },
    },
  }
  return api
}

function fakeTx(hash, _tag) {
  // kept for the S3 override — mock convention: toHex() returns the tx own hash
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
let nodeSeq = 0
// F02 semantics: node bytes must be real, decodable PBNodes (on-chain extraction
// goes through tryDecodeRemark) and the cid must be self-consistent with the
// bytes — hand-encode PBNode{data: 2-byte counter}; the cid comes from the same
// decode path (tryDecodeRemark consumes inner bytes without the compact prefix,
// same as block args[0])
const mkNode = () => {
  const i = nodeSeq++
  const bytes = Uint8Array.from([0x0a, 0x02, (i >> 8) & 0xff, i & 0xff])
  const cid = tryDecodeRemark(bytes)?.cid
  assert(cid, `mkNode ${i} failed to decode`)
  return { cid, blake3: `blake${i}`, bytes }
}
const prepared = (nodes = 3, cid = `bafk-sc${++cidSeq}`) => ({
  file: { name: 'test.bin', size: 100, sha256: 'ab'.repeat(32), mimeType: null },
  rootCid: cid,
  nodes: Array.from({ length: nodes }, () => mkNode()),
  totalBytes: nodes * 100,
})
const onStage = () => {}
const FAST = { scanTimeoutMs: 400, confirmTimeoutMs: 800, depth: 1 }

// ---- S1 accepted but response lost -> result unknown, no fallback, task persisted ----
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
  ok(JSON.stringify(pending[0]?.txNodes) === '[3]', `S1 txNodes records the node coverage plan (${pending[0]?.txNodes})`)
  ok(pending[0]?.network === 'Subspace Mainnet' && pending[0]?.uploader === '5Htest', 'S1 task captured network/uploader (F03)')
}

// ---- S2 accepted but never included -> TxNotFoundError, no fallback ----
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

// ---- S3 declined signing: pre-signing failure, no task, no fallback ----
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

// ---- S4 definitive capacity rejection -> per-tx fallback, all confirmed ----
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
  // F03: the manifest and the task deletion commit together — present in the manifests store right after success
  const stored = await storeM.getManifest(sc4cid)
  ok(stored?.rootCid === sc4cid && stored?.uploader?.address === '5Htest', 'S4 manifest atomically persisted alongside task cleanup (F03)')
}

// ---- S5 banned rejection -> no fallback (the tx may be in the pool), task persisted ----
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

// ---- S6 recover the manifest by rescanning the task hashes (tx on-chain) ----
{
  const pending = await listPendingPublish()
  const record = pending.find((p) => p.rootCid?.startsWith('bafk-s5'))
  // simulate the tx getting included afterwards: seed the chain with the S5 batch hash
  const api = mockApi({ submitBehavior: 'ok', submits: [], chain: record.txHashes.slice(), remarkCalls: 0, remarkHashes: [], chainPushIdx: 0, headStep: 1 })
  const manifest = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  ok(manifest !== null, 'S6 rescan found every tx and recovered the manifest')
  ok(manifest?.rootCid === record.rootCid && manifest?.nodes?.length === 3, `S6 manifest rebuilt from task metadata (rootCid/nodes)`)
  ok(manifest?.txs?.length === 1 && manifest.txs[0].txHash === record.txHashes[0], `S6 txs record the verified inclusion`)
  ok(manifest?.uploader?.address === '5Htest' && manifest?.network === 'mainnet', 'S6 uploader/network taken from task-captured values (F03)')
  ok(!(await listPendingPublish()).some((p) => p.rootCid === record.rootCid), 'S6 task cleaned up after successful recovery')
  // F03: manifest persistence and task deletion commit together — present in the manifests store right after recovery
  const stored = await storeM.getManifest(record.rootCid)
  ok(stored?.rootCid === record.rootCid, 'S6 manifest atomically persisted alongside task cleanup (F03)')
}

// ---- S7 still not found -> null, task kept ----
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

// ---- S8 node rejects the second per-tx submit (F02): the task holds only the signed txs -> verification refuses to complete ----
{
  // batch capacity-rejected (submits[0]) -> per-tx: submits[1]=tx0 ok, submits[2]=tx1 rejected
  const scenario = { submitBehavior: 'too-large', rejectAt: 2, submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  const api = mockApi(scenario)
  const sc8cid = `bafk-s8-${Date.now()}`
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc8cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err instanceof TxRejectedError, `S8 second tx rejected by the node (${err?.name})`)
  const pending = await listPendingPublish()
  const record = pending.find((p) => p.rootCid === sc8cid)
  // the second tx was signed and persisted before submission (a node rejection
  // is not "never signed") — the task holds 2 hashes / 2 nodes, plan covers 2/3
  ok(record && record.txHashes.length === 2 && JSON.stringify(record.txNodes) === '[1,1]', `S8 task holds both signed txs (${record?.txHashes?.length} hash / ${record?.txNodes})`)
  const got = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  ok(got === null, 'S8 incomplete coverage plan -> refuses to complete (no node-missing manifest)')
  const after = (await listPendingPublish()).find((p) => p.id === record.id)
  // no dictionaries injected in Node: t() returns the key verbatim — asserting the key is asserting the marker
  ok(after && after.lastError === 'publishPending.incomplete', `S8 task marked with the gap reason (${after?.lastError})`)
  ok(!(await storeM.getManifest(sc8cid)), 'S8 no manifest persisted')
}

// ---- S8b signing declined mid per-tx fallback (F02 acceptance): like S8 but the second tx is never signed ----
{
  const scenario = { submitBehavior: 'too-large', submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  const api = mockApi(scenario)
  const sc8bcid = `bafk-s8b-${Date.now()}`
  // after the batch capacity rejection the first tx signs normally; from the
  // second on, remark signing is declined — the check uses the submits count
  // (the batch attempt is 1) and is EVALUATED AT SIGN TIME
  const origRemark = api.tx.system.remark.bind(api.tx)
  api.tx.system.remark = (payload) => {
    const tx = origRemark(payload)
    const origSign = tx.signAsync.bind(tx)
    tx.signAsync = async (...a) => {
      if (scenario.submits.length >= 2) throw new Error('user rejected signing')
      return origSign(...a)
    }
    return tx
  }
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc8bcid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err && /rejected/.test(err.message), `S8b second tx signing declined (${String(err?.message).slice(0, 30)})`)
  const record = (await listPendingPublish()).find((p) => p.rootCid === sc8bcid)
  ok(record && record.txHashes.length === 1, 'S8b task holds only the first hash')
  const got = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  const after = (await listPendingPublish()).find((p) => p.id === record.id)
  ok(got === null && after?.lastError === 'publishPending.incomplete', 'S8b verification refuses to complete and marks the gap')
}

// ---- S9 empty-hash task (F02): interrupted after the capacity rejection, before the first signature -> refuses to complete ----
{
  const scenario = { submitBehavior: 'too-large', rejectSign: true, submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  const api = mockApi(scenario)
  const sc9cid = `bafk-s9-${Date.now()}`
  // the batch tx must still sign (to reach the capacity rejection path); only
  // per-tx remarks decline — override the batch signAsync to a no-op
  const origBatch = api.tx.utility.batch.bind(api.tx)
  api.tx.utility.batch = (calls) => {
    const tx = origBatch(calls)
    tx.signAsync = async () => {}
    return tx
  }
  let err = null
  try {
    await publishPrepared(api, prepared(3, sc9cid), signer, onStage, {}, FAST)
  } catch (e) {
    err = e
  }
  ok(err && /rejected/.test(err.message), `S9 first per-tx signing declined (${String(err?.message).slice(0, 30)})`)
  const record = (await listPendingPublish()).find((p) => p.rootCid === sc9cid)
  ok(record && record.txHashes.length === 0, 'S9 empty-hash task persisted')
  const got = await verifyPublishTask(api, record, { depth: 1, timeoutMs: 800 })
  ok(got === null, 'S9 an empty loop no longer "succeeds" -> refuses to complete')
  const after = (await listPendingPublish()).find((p) => p.id === record.id)
  ok(after && after.lastError === 'publishPending.emptyTask', 'S9 task marked with the empty-task reason')
  await dismissPendingPublish(record)
}

// ---- S10 on-chain coverage gap (F02 extraction semantics, legacy tasks with txNodes=null) ----
{
  // publish 2 nodes normally (batch succeeds) -> extend the task's node list to
  // 3 by hand (simulating a legacy/metadata gap): txNodes=null goes through the
  // pure on-chain extraction comparison, 1 missing node must refuse completion
  const scenario = { submitBehavior: 'ok', submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  scenario.headStep = 1
  const api = mockApi(scenario)
  const nodes2 = prepared(2, `bafk-s10-${Date.now()}`)
  // persist:false — only borrow the publish to get the batch hash and chain content, no manifest persisted
  const manifest = await publishPrepared(api, nodes2, signer, onStage, {}, { ...FAST, persist: false })
  const batchHash = manifest.txs[0].txHash
  const record = {
    id: `publish:${nodes2.rootCid}`,
    kind: 'publish',
    rootCid: nodes2.rootCid,
    file: nodes2.file,
    overridesFile: null,
    encryption: null,
    nodes: [...nodes2.nodes, mkNode()], // one extra node that does not exist on-chain
    totalBytes: 300,
    startHeight: HEAD,
    txHashes: [batchHash],
    txNodes: null, // legacy task, no mapping
    network: 'Subspace Mainnet',
    uploader: '5Htest',
    persistManifest: true,
    status: 'pending-verify',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await storeM.putPublishTask(record)
  const api2 = mockApi({ submitBehavior: 'ok', submits: [], chain: [batchHash], remarkCalls: 0, remarkHashes: [], headStep: 1 })
  const got = await verifyPublishTask(api2, record, { depth: 1, timeoutMs: 800 })
  ok(got === null, 'S10 extraction finds a missing node -> refuses to complete (legacy-task semantics)')
  const after = await storeM.listPublishTasks().then((all) => all.find((p) => p.id === record.id))
  ok(after && after.lastError === 'publishPending.coverageGap', `S10 task marked with the coverage gap (${after?.lastError})`)
  ok(!(await storeM.getManifest(record.rootCid)), 'S10 no manifest persisted')
  await storeM.deletePublishTask(record.id)
}

// ---- S11 recovery bypasses the file list for persistManifest=false tasks ----
{
  // publish successfully with persist:false (task already deleted) -> recreate
  // a pending task with the same hash (persistManifest=false, mirroring the
  // manifest-file publish recovery path)
  const scenario = { submitBehavior: 'ok', submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  scenario.headStep = 1
  const api = mockApi(scenario)
  const p1 = prepared(2, `bafk-s11-${Date.now()}`)
  const manifest = await publishPrepared(api, p1, signer, onStage, {}, { ...FAST, persist: false })
  const batchHash = manifest.txs[0].txHash
  ok(!(await storeM.getManifest(p1.rootCid)), 'S11 precondition: a persist:false publish stays out of the file list')
  const record = {
    id: `publish:${p1.rootCid}`,
    kind: 'publish',
    rootCid: p1.rootCid,
    file: p1.file,
    overridesFile: null,
    encryption: null,
    nodes: p1.nodes,
    totalBytes: 200,
    startHeight: HEAD,
    txHashes: [batchHash],
    txNodes: null,
    network: 'Subspace Mainnet',
    uploader: '5Htest',
    persistManifest: false,
    status: 'pending-verify',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await storeM.putPublishTask(record)
  const api2 = mockApi({ submitBehavior: 'ok', submits: [], chain: [batchHash], remarkCalls: 0, remarkHashes: [], headStep: 1 })
  const got = await verifyPublishTask(api2, record, { depth: 1, timeoutMs: 800 })
  ok(got?.rootCid === p1.rootCid, 'S11 verification succeeds and returns the manifest (not persisted)')
  ok(!(await listPendingPublish()).some((p) => p.id === record.id), 'S11 task deleted')
  ok(!(await storeM.getManifest(p1.rootCid)), 'S11 persistManifest=false -> recovery stays out of the file list too')
}

// ---- S12 persist:false (the manifest-file publish path): task cleaned up, nothing enters the file list ----
{
  const scenario = { submitBehavior: 'ok', submits: [], chain: [], remarkCalls: 0, remarkHashes: [] }
  const api = mockApi(scenario)
  const sc12cid = `bafk-s12-${Date.now()}`
  const manifest = await publishPrepared(api, prepared(2, sc12cid), signer, onStage, {}, { ...FAST, persist: false })
  ok(manifest?.rootCid === sc12cid, 'S12 publish succeeds and returns the manifest')
  ok(!(await listPendingPublish()).some((p) => p.rootCid === sc12cid), 'S12 task cleaned up')
  ok(!(await storeM.getManifest(sc12cid)), 'S12 persist:false -> the manifest stays out of the file list (manifestPublish semantics)')
}

console.log(`\nAll ${passed} assertions passed ✓ (publish-error-test)`)
process.exit(0)
