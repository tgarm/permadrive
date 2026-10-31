// R03/R04/R08 offline tests (design review): IndexedDB transaction semantics,
// idempotent message merges, atomic cursor commits, decrypt-status persistence
// and retries. Second review (F04): same-height cursor pairing and
// orphan invalidation. Runs the REAL store.ts + mailbox.ts decryption path
// (viem HDAccount local signing, zero network). IndexedDB via fake-indexeddb.
//   node mailbox-store-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

const storeM = await import('../../frontend/src/lib/store.ts')
const boxM = await import('../../frontend/src/lib/boxCrypto.ts')
const mailboxM = await import('../../frontend/src/lib/mailbox.ts')
const { privateKeyToAccount } = await import('viem/accounts')

const { listMessages, putMessage, putMessageDecryptResult, putMessagesWithCursor, getMeta, putMeta, markMessageRead, mergeMessage, normalizeMessage } = storeM
const { decryptMessage, decryptPendingMessages, cursorKeyFor, normalizeCursor, cursorAfterSync, staleMessageIds } = mailboxM
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

// ---- 1. mergeMessage idempotent semantics (R03/R04) ----
{
  const a = record()
  const replay = record({ plain: null, read: false, blockHash: null }) // replay: no plaintext, unread
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

// ---- 2. putMessage atomic merge write (read-merge-write in one transaction) ----
{
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' }))
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' })) // replay
  await putMessageDecryptResult('c1:1:0xa', 'secret text', null)
  await putMessage(record({ id: 'c1:1:0xa', plain: null, decryptStatus: 'locked' })) // replay again
  const all = await listMessages()
  const m = all.find((x) => x.id === 'c1:1:0xa')
  ok(m?.plain === 'secret text' && m.decryptStatus === 'ok', '2 replay after successful decryption: plaintext and status kept')
  await markMessageRead('c1:1:0xa')
  await putMessage(record({ id: 'c1:1:0xa', read: false }))
  const m2 = (await listMessages()).find((x) => x.id === 'c1:1:0xa')
  ok(m2?.read === true, '2 read flag not reset by later writes')
}

// ---- 3. putMessagesWithCursor atomicity (R08): a bad record aborts the batch, cursor not advanced ----
{
  const good = record({ id: 'c2:1:0xb' })
  // a record without an id -> put throws DataError -> transaction aborts
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

// ---- 4. cursor key triple isolation (R04) ----
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

// ---- 5. decryption retry (R03): locked -> decrypted without rescanning history; failures isolated ----
{
  // viem HDAccount local signer (RFC6979 deterministic; local signing, zero network)
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

  // first decrypt succeeds: plaintext recovered + status ok — no historical rescan needed
  const plain = await decryptMessage(signer, (await listMessages()).find((x) => x.id === mOk.id))
  ok(plain === 'second try works', '5 locked message decrypts (the mechanism behind retry-after-decline recovery)')
  ok(((await listMessages()).find((x) => x.id === mOk.id)).decryptStatus === 'ok', '5 success status persisted')

  // one failure does not block the rest: bulk decrypt -> the good message succeeds, the bad one persists its reason
  const okCount = await decryptPendingMessages(signer)
  ok(okCount === 0, `5 bulk decrypt (the good message was already decrypted above)`)
  const after = await listMessages()
  const bad = after.find((x) => x.id === mBad.id)
  ok(bad.decryptStatus === 'failed' && !!bad.decryptError, '5 bad message failure reason persisted (per-message isolation)')
  ok(after.find((x) => x.id === mOther.id).decryptStatus === 'locked', '5 messages addressed to others untouched (recipient filter)')

  // retrying the bad message still fails (the error path is re-callable, not blocking)
  let threw = false
  try {
    await decryptMessage(signer, bad)
  } catch {
    threw = true
  }
  ok(threw, '5 explicit decrypt of a failing message throws (the UI-facing behavior)')
  ok((await listMessages()).find((x) => x.id === mOk.id).plain === 'second try works', '5 retrying a failure does not damage the succeeded message')
}

// ---- 6. F04: cursor semantics (same-height pairing) and orphan invalidation (second design review) ----
{
  // cursorAfterSync invariant: the checkpoint records toBlock itself — the
  // height pairs with nextBlock-1. The old code stored toBlock's hash against a
  // toBlock+1 query height, so even a healthy chain mismatched every sync.
  const c = cursorAfterSync(500, '0xabc')
  ok(c.nextBlock === 501 && c.checkpoint.height === 500 && c.checkpoint.hash === '0xabc', '6 cursorAfterSync same-height pairing (height = nextBlock-1)')
  ok(cursorAfterSync(500, null).checkpoint === null && cursorAfterSync(0, '0xabc').checkpoint === null, '6 no hash / zero block -> no checkpoint')
  // reorg-check semantics: read at the same height —
  // getBlock(checkpoint.height).hash must equal checkpoint.hash (guaranteed by
  // construction); any "compare hashes at the same height" implementation no
  // longer misaligns
  ok(c.checkpoint.height === c.nextBlock - 1, '6 the height the next sync verifies is exactly the last processed block')

  // legacy cursor migration: the {block, blockHash} semantics carry over exactly
  // (blockHash was the hash of block-1 -> checkpoint.height = block-1)
  const legacy = normalizeCursor({ block: 501, blockHash: '0xold' })
  ok(legacy.nextBlock === 501 && legacy.checkpoint.height === 500 && legacy.checkpoint.hash === '0xold', '6 legacy {block,blockHash} migration pairs correctly')
  ok(normalizeCursor({ block: 501, blockHash: null }).checkpoint === null, '6 legacy without a hash -> no checkpoint')
  ok(normalizeCursor(501).nextBlock === 501 && normalizeCursor(501).checkpoint === null, '6 older plain block number -> no checkpoint')
  ok(normalizeCursor(null).nextBlock === 0 && normalizeCursor('x').nextBlock === 0 && normalizeCursor({ nextBlock: 'x' }).nextBlock === 0, '6 malformed shapes reset to zero (extra rescans merge idempotently, always safe)')
  const modern = normalizeCursor({ nextBlock: 700, checkpoint: { height: 699, hash: '0xnew' } })
  ok(modern.nextBlock === 700 && modern.checkpoint.hash === '0xnew', '6 new format passes through')
  ok(normalizeCursor({ nextBlock: 700, checkpoint: { height: 'x', hash: 5 } }).checkpoint === null, '6 malformed checkpoint shape -> dropped (no check, no misfire)')

  // orphan invalidation pure function: records inside the window not reproduced
  // by the canonical scan are pending deletion; outside the window / other
  // chain / seen this round / no block number are all kept
  const contract = '0xmailbox'
  const mk = (id, blockNumber, chainId = 870) => record({ id, blockNumber, chainId })
  const all = [
    mk('0xmailbox:1:0xa', 100), // inside the window + not reproduced -> delete
    mk('0xmailbox:2:0xb', 100), // inside the window + reproduced -> keep
    mk('0xmailbox:3:0xc', 50), // outside the window -> keep
    mk('0xmailbox:4:0xd', 100, 1), // other chain -> keep
    mk('0xother:5:0xe', 100), // other contract -> keep
    mk('0xmailbox:6:0xf', 0), // no block number (legacy) -> keep (conservative)
  ]
  const stale = staleMessageIds(all, contract, 870, 90, 110, new Set(['0xmailbox:2:0xb']))
  ok(JSON.stringify(stale) === JSON.stringify(['0xmailbox:1:0xa']), `6 orphan invalidation deletes only unseen records inside the window (${stale})`)
  ok(staleMessageIds(all, contract, 870, 90, 110, new Set()).length === 2, '6 none reproduced -> two pending deletions')
  ok(staleMessageIds([], contract, 870, 90, 110, new Set()).length === 0, '6 empty store -> nothing to delete')

  // putMessagesWithCursor deletion path: write 2 records + cursor + delete 1, one transaction
  await putMeta(cursorKeyFor(contract, '0xtester'), null)
  const keep1 = mk('0xmailbox:11:0xk1', 120)
  const staleRec = mk('0xmailbox:12:0xs1', 120)
  await putMessagesWithCursor([keep1, staleRec], cursorKeyFor(contract, '0xtester'), cursorAfterSync(120, '0xh1'), [])
  ok((await listMessages()).some((m) => m.id === staleRec.id), '6 precondition: both records stored')
  const keep2 = mk('0xmailbox:13:0xk2', 121)
  await putMessagesWithCursor([keep2], cursorKeyFor(contract, '0xtester'), cursorAfterSync(121, '0xh2'), [staleRec.id])
  const after = await listMessages()
  ok(!after.some((m) => m.id === staleRec.id), '6 the orphaned message was deleted in the same transaction')
  ok(after.some((m) => m.id === keep1.id) && after.some((m) => m.id === keep2.id), '6 kept records unaffected')
  const cur = normalizeCursor(await getMeta(cursorKeyFor(contract, '0xtester')))
  ok(cur.nextBlock === 122 && cur.checkpoint.height === 121, '6 cursor advance and deletion in one transaction (F04)')

  // plaintext preservation is unaffected by orphan deletion: a record with
  // plaintext that IS reproduced canonically keeps it via merge
  await putMessage(mk('0xmailbox:14:0xp1', 122))
  await putMessageDecryptResult('0xmailbox:14:0xp1', 'secret text', null)
  const replayed = record({ id: '0xmailbox:14:0xp1', blockNumber: 122 })
  await putMessagesWithCursor([replayed], cursorKeyFor(contract, '0xtester'), cursorAfterSync(122, '0xh3'), [])
  const kept = (await listMessages()).find((m) => m.id === '0xmailbox:14:0xp1')
  ok(kept.plain === 'secret text' && kept.decryptStatus === 'ok', '6 a canonical replay does not clear plaintext (merge semantics intact)')
}

console.log(`\nAll ${passed} assertions passed ✓ (mailbox-store-test)`)
process.exit(0)
