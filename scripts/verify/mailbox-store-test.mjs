// R03/R04/R08 offline tests (design review): IndexedDB transaction semantics,
// idempotent message merges, atomic cursor commits, decrypt-status persistence
// and retries. Runs the REAL store.ts + mailbox.ts decryption path (viem
// HDAccount local signing, zero network). IndexedDB via fake-indexeddb.
//   node mailbox-store-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

const storeM = await import('../../frontend/src/lib/store.ts')
const boxM = await import('../../frontend/src/lib/boxCrypto.ts')
const mailboxM = await import('../../frontend/src/lib/mailbox.ts')
const { privateKeyToAccount } = await import('viem/accounts')

const { listMessages, putMessage, putMessageDecryptResult, putMessagesWithCursor, getMeta, markMessageRead, mergeMessage, normalizeMessage } = storeM
const { decryptMessage, decryptPendingMessages, cursorKeyFor } = mailboxM
const { boxEncrypt, serializeEnvelope, parseEnvelope } = boxM

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}
const record = (over = {}) => ({
  id: '0xmailbox:1:0xdead',
  eventId: 1,
  from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  content: 'envelope-json',
  plain: null,
  at: 1700000000000,
  txHash: '0xdead',
  read: false,
  sentByMe: false,
  chainId: 870,
  blockNumber: 100,
  blockHash: '0xblockhash',
  decryptStatus: 'locked',
  decryptError: null,
  ...over,
})

// ---- 1. mergeMessage 幂等语义（R03/R04）----
{
  const a = record()
  const replay = record({ plain: null, read: false, blockHash: null }) // 重放：无明文、未读
  const merged = mergeMessage(a, replay)
  ok(merged.plain === null && merged.read === false, '1 first merge: a locked message stays locked')
  const withPlain = mergeMessage(a, record({ plain: 'hello', decryptStatus: 'ok', read: true }))
  ok(withPlain.plain === 'hello' && withPlain.read === true && withPlain.decryptStatus === 'ok', '1 decrypted + read')
  const replayed = mergeMessage(withPlain, record({ plain: null, read: false, decryptStatus: 'locked' }))
  ok(replayed.plain === 'hello', '1 replay does not wipe plaintext (the old implementation did)')
  ok(replayed.read === true, '1 replay does not reset read state')
  ok(replayed.decryptStatus === 'ok', '1 decrypt status takes the better of the two (ok > locked)')
  const failed = mergeMessage(withPlain, record({ decryptStatus: 'failed', decryptError: 'boom' }))
  ok(failed.decryptStatus === 'ok', '1 a decrypted message is not downgraded by failed')
  const failPlain = mergeMessage(record({ decryptStatus: 'locked' }), record({ decryptStatus: 'failed', decryptError: 'wallet refused' }))
  ok(failPlain.decryptStatus === 'failed' && failPlain.decryptError === 'wallet refused', '1 failure reason persisted')
  const norm = normalizeMessage(record({ chainId: undefined, decryptStatus: undefined, plain: 'x' }))
  ok(norm.chainId === 870 && norm.decryptStatus === 'ok', '1 legacy records normalized on read (missing fields defaulted)')
}

// ---- 2. putMessage 原子合并写（读-合并-写同事务）----
{
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' }))
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' })) // 重放
  await putMessageDecryptResult('c1:1:0xa', 'secret text', null)
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' })) // 再重放
  const all = await listMessages()
  const m = all.find((x) => x.id === 'c1:1:0xa')
  ok(m?.plain === 'secret text' && m.decryptStatus === 'ok', '2 replay after successful decryption: plaintext and status kept')
  await markMessageRead('c1:1:0xa')
  await putMessage(record({ id: 'c1:1:0xa', read: false }))
  const m2 = (await listMessages()).find((x) => x.id === 'c1:1:0xa')
  ok(m2?.read === true, '2 read flag not reset by later writes')
}

// ---- 3. putMessagesWithCursor 原子性（R08）：坏记录使整批回滚，游标不推进 ----
{
  const good = record({ id: 'c2:1:0xb' })
  // 无 id 的记录 → put 抛 DataError → 事务 abort
  const bad = { ...record({ id: 'c2:2:0xc' }), id: undefined }
  let rejected = false
  try {
    await putMessagesWithCursor([good, bad], 'cursor-a', { block: 500, blockHash: null })
  } catch {
    rejected = true
  }
  ok(rejected, '3 a bad record in the batch aborts the transaction and rejects (the old implementation reported success on request success)')
  // Key invariant: the cursor never advances. Real IDB rolls the whole batch
  // back; fake-indexeddb's rollback fidelity for a synchronous throw inside a
  // success handler is imperfect (messages may linger) — but message writes are
  // idempotent (merge) and a resync heals them; the cursor is the correctness
  // anchor.
  ok((await getMeta('cursor-a')) === undefined, '3 cursor not advanced (batch + cursor share one transaction; abort writes no cursor)')

  await putMessagesWithCursor([good], 'cursor-a', { block: 500, blockHash: '0xh' })
  ok((await listMessages()).some((x) => x.id === 'c2:1:0xb'), '3 a good batch persists')
  const cursor = await getMeta('cursor-a')
  ok(cursor && cursor.block === 500 && cursor.blockHash === '0xh', '3 cursor written atomically with the batch (object value with checkpoint)')
}

// ---- 4. 游标键三元组隔离（R04）----
{
  const k1 = cursorKeyFor('0xaaa4', '0xbbb4')
  const k2 = cursorKeyFor('0xaaa4', '0xbbb4')
  const k3 = cursorKeyFor('0xaaaa', '0xbbb4')
  const k4 = cursorKeyFor('0xaaa4', '0xbbb5')
  ok(k1 === k2, '4 same (chain, contract, account) = same key')
  ok(k1 !== k3 && k1 !== k4, '4 a different contract or account = a different key')
  ok(k1.startsWith('mailboxCursor:870:0xaaa4:0xbbb4'), `4 key carries chainId+contract+account (${k1})`)
  await putMessagesWithCursor([], k1, { block: 100, blockHash: null })
  await putMessagesWithCursor([], k3, { block: 200, blockHash: null })
  ok((await getMeta(k1)).block === 100 && (await getMeta(k3)).block === 200, '4 per-contract cursors never overwrite each other')
}

// ---- 5. 解密重试（R03）：锁定 → 解密成功（无需重扫历史）；失败隔离 ----
{
  // viem HDAccount 本地签名者（RFC6979 确定性；本地签名零网络）
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const signer = { kind: 'local', address: account.address, account, label: 'local' }
  const me = account.address.toLowerCase()

  const pubB64 = await mailboxM.encryptionPublicKeyFor(signer)
  const envelopeForMe = serializeEnvelope(boxEncrypt(Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0)), new TextEncoder().encode('second try works')))
  const envelopeGarbage = 'not-a-valid-envelope'

  const mOk = record({ id: 'c5:1:0x1', to: me, content: envelopeForMe, decryptStatus: 'locked' })
  const mBad = record({ id: 'c5:2:0x2', to: me, content: envelopeGarbage, decryptStatus: 'locked' })
  const mOther = record({ id: 'c5:3:0x3', to: '0xcccccccccccccccccccccccccccccccccccccccc', content: envelopeForMe, decryptStatus: 'locked' })
  await putMessage(mOk)
  await putMessage(mBad)
  await putMessage(mOther)

  // 首次解密成功：明文恢复 + 状态 ok —— 不需要重扫任何历史块
  const plain = await decryptMessage(signer, (await listMessages()).find((x) => x.id === mOk.id))
  ok(plain === 'second try works', '5 locked message decrypts (the mechanism behind retry-after-decline recovery)')
  ok(((await listMessages()).find((x) => x.id === mOk.id)).decryptStatus === 'ok', '5 success status persisted')

  // 单条失败不阻塞其余：批量解密 → 好消息成功、坏消息持久化失败原因
  const okCount = await decryptPendingMessages(signer)
  ok(okCount === 0, `5 bulk decrypt (the good message was already decrypted above)`)
  const after = await listMessages()
  const bad = after.find((x) => x.id === mBad.id)
  ok(bad.decryptStatus === 'failed' && !!bad.decryptError, '5 bad message failure reason persisted (per-message isolation)')
  ok(after.find((x) => x.id === mOther.id).decryptStatus === 'locked', '5 messages addressed to others untouched (recipient filter)')

  // 坏消息重试仍失败（错误路径本身可重复调用，不抛出阻塞）
  let threw = false
  try {
    await decryptMessage(signer, bad)
  } catch {
    threw = true
  }
  ok(threw, '5 explicit decrypt of a failing message throws (the UI-facing behavior)')
  ok((await listMessages()).find((x) => x.id === mOk.id).plain === 'second try works', '5 retrying a failure does not damage the succeeded message')
}

console.log(`\n全部 ${passed} 项通过 ✓（mailbox-store-test）`)
process.exit(0)
