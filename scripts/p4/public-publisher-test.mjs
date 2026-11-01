// PublicPublisher offline adversarial tests — local ganache EVM (same setup
// as direct-sales-test), zero mainnet funds. DirectSales deploys from the
// compiled artifact (treasury=A) with PublicPublisher pointing at it — covers:
//   p01 non-seller call reverts (NotListingSeller)
//   p02 listingId mismatch reverts (ListingMismatch)
//   p03 publish on an unlisted file -> the purchase backstop reverts (NotListed)
//   p04 value != DUST_PRICE reverts (WrongValue); a listing priced
//       != DUST_PRICE is caught by ExactPaymentRequired / PriceTooHigh instead
//   p05 stale revision reverts (NotCurrentRevision)
//   p06 key length != 32 reverts (BadKeyLength)
//   p07 manifestCid over 128 chars reverts (CidTooLong)
//   p08 happy path: all event fields correct + the order stored
//       (buyer=publisher, price=DUST_PRICE) + the seller's net cost = gas +
//       platform fee (90% of the dust returns; DUST_PRICE 1e13 = 10x the
//       Auto-EVM domain ED, measured by bisection 2026-11-01 - the 1 wei
//       version was rejected by the domain's recipient-side dust floor)
//   p09 republishing creates a second harmless order (idempotent)
//   p10 DirectSales storage untouched (regression): both contract balances 0,
//       treasury receives exactly the platform fees, buyerCount exactly +1,
//       an existing high-price listing unaffected by the dust-price one
//   p11 sales() immutable readback + bytecode equality (patchImmutablesMulti)
//       — the deploy-time check that excludes a fake sales
// Balance assertions: treasury(A) differs from every acting signer, so native
// balance deltas are exact; the signer's own gas is subtracted via gasOf.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const SALES = JSON.parse(readFileSync(new URL('../../contracts/out/DirectSales.json', import.meta.url).pathname, 'utf8'))
const PUB = JSON.parse(readFileSync(new URL('../../contracts/out/PublicPublisher.json', import.meta.url).pathname, 'utf8'))
const MNEMONIC = 'test test test test test test test test test test test junk'

// ---- Local EVM lifecycle (in-process ganache by default; LOCAL_EVM_RPC can point at anvil etc.) ----

const EXTERNAL_RPC = process.env.LOCAL_EVM_RPC || process.env.ANVIL_RPC || null
let server = null
let rpcUrl = EXTERNAL_RPC
if (!rpcUrl) {
  const ganache = (await import('ganache')).default
  for (let attempt = 0; ; attempt++) {
    const port = 46000 + Math.floor(Math.random() * 8000)
    const candidate = ganache.server({ chain: { chainId: 1337 }, wallet: { mnemonic: MNEMONIC }, logging: { quiet: true } })
    try {
      await candidate.listen(port)
      server = candidate
      rpcUrl = `http://127.0.0.1:${port}`
      break
    } catch (e) {
      if (e?.code === 'EADDRINUSE' && attempt < 4) continue
      throw e
    }
  }
}
const cleanup = async () => { if (server) { try { await server.close() } catch { /* ignore */ } server = null } }
process.on('SIGINT', () => { void cleanup(); process.exit(130) })

const localChain = defineChain({
  id: 1337,
  name: 'local-evm',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const ACCOUNT_KEYS = [
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80n, // #0
  0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690dn, // #1
  0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffban, // #2
]
function clientFor(i) {
  const account = privateKeyToAccount(`0x${ACCOUNT_KEYS[i].toString(16).padStart(64, '0')}`)
  return {
    account,
    address: account.address,
    publicClient: createPublicClient({ chain: localChain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain: localChain, transport: http(rpcUrl) }),
  }
}
const A = clientFor(0) // treasury (DirectSales constructor arg)
const B = clientFor(1) // seller
const C = clientFor(2) // attacker
console.log('local evm:', rpcUrl)
console.log('A (treasury):', A.address, '· B (seller):', B.address, '· C (attacker):', C.address)

// ---- Deploy: DirectSales(treasury=A) -> PublicPublisher(sales=SALES) ----

async function deploy(c, artifact, args = []) {
  const h = await c.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args, chain: localChain })
  const rx = await c.publicClient.waitForTransactionReceipt({ hash: h })
  if (rx.status !== 'success') throw new Error('deploy failed')
  return { addr: rx.contractAddress, rx }
}
const { addr: SALES_ADDR, rx: salesRx } = await deploy(A, SALES, [A.address])
console.log('DirectSales:', SALES_ADDR, `· block ${salesRx.blockNumber} · gas ${salesRx.gasUsed}`)
const { addr: PUB_ADDR, rx: pubRx } = await deploy(A, PUB, [SALES_ADDR])
console.log('PublicPublisher:', PUB_ADDR, `· block ${pubRx.blockNumber} · gas ${pubRx.gasUsed}`)

const SP = SALES.abi
const PP = PUB.abi
const read = (fn, args = [], abi = SP, addr = SALES_ADDR) => A.publicClient.readContract({ address: addr, abi, functionName: fn, args })
async function write(c, fn, args = [], value = 0n, abi = SP, addr = SALES_ADDR) {
  const h = await c.walletClient.writeContract({ address: addr, abi, functionName: fn, args, chain: localChain, ...(value ? { value } : {}) })
  const rx = await c.publicClient.waitForTransactionReceipt({ hash: h })
  if (rx.status !== 'success') throw new Error(`${fn} tx ${rx.status}`)
  return rx
}
const gasOf = (rx) => rx.gasUsed * (rx.effectiveGasPrice ?? 0n)
const bal = (c) => c.publicClient.getBalance({ address: c.address })
const key = (tag) => keccak256(toHex(`public-publisher-test-${tag}`))
const mCid = (tag) => `bafkr${tag}${'a'.repeat(Math.max(0, 50 - tag.length))}` // pseudo-CID string (only feeds events and the fileKey derivation; just needs a legal length)
const lidOf = (seller, fk) => keccak256(`0x${seller.slice(2).toLowerCase()}${fk.slice(2).toLowerCase().padStart(64, '0')}`)
const ZERO = '0x0000000000000000000000000000000000000000'
const K1 = keccak256(toHex('file-key-one'))
const K2 = keccak256(toHex('file-key-two'))
const SHA1 = keccak256(toHex('plain-sha-one'))
const SHA2 = keccak256(toHex('plain-sha-two'))
const DUST = 10n ** 13n // DUST_PRICE (mirrors the contract constant; mainnet readback is asserted by p00)
const FEE = (DUST * 1000n) / 10000n // platformBps defaults to 1000 -> the fee is exactly 1e12

const errText = (e) => {
  const parts = []
  let cur = e
  for (let d = 0; cur && d < 8; d++) {
    parts.push(String(cur.shortMessage || cur.message || cur))
    if (cur.details) parts.push(String(cur.details))
    if (cur.data?.result) parts.push(String(cur.data.result))
    cur = cur.cause
  }
  return parts.join(' | ')
}
// ganache reverts return only the 4-byte selector (no error name) — build one selector map from both ABIs
const errSel = {}
for (const item of [...SP, ...PP]) {
  if (item.type === 'error') {
    const sig = `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(',')})`
    errSel[keccak256(toHex(sig)).slice(2, 10)] = item.name
  }
}
async function expectRevert(fn, reason) {
  try {
    await fn()
  } catch (e) {
    const s = errText(e)
    const sel = Object.keys(errSel).find((k) => errSel[k] === reason)
    if (s.includes(reason) || (sel && s.includes(sel))) return
    throw new Error(`expected revert(${reason}) but got: ${s.slice(0, 240)}`)
  }
  throw new Error(`expected revert(${reason}) but the transaction succeeded`)
}
const pubEvents = (rx) => rx.logs.map((l) => { try { return decodeEventLog({ abi: PP, data: l.data, topics: l.topics }) } catch { return null } }).filter(Boolean)

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    void cleanup()
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// ---- Constant readback (part of the deploy-time trust-domain check) ----

ok((await read('DUST_PRICE', [], PP, PUB_ADDR)) === DUST, 'p00 DUST_PRICE == 1e13 shannon (10x domain ED)')
ok((await read('MAX_CID_LENGTH', [], PP, PUB_ADDR)) === 128n, 'p00 MAX_CID_LENGTH == 128')

// Inside the contract fileKey = keccak256(manifestCid) (derived in publish) —
// the listing's fileKey in these tests must derive from the same cid, or the
// ListingMismatch check rejects before purchase is reached
const cidFk = (tag) => keccak256(toHex(mCid(tag)))

// A normally-priced listing (for p04c: a listing priced != DUST_PRICE is caught by the purchase backstop)
const FK_HIGH = cidFk('high')
await write(B, 'createRevision', [FK_HIGH, 10n ** 17n, ZERO, ZERO, 0, 0, keccak256(toHex('')), 0n, '0x'])
const LID_HIGH = lidOf(B.address, FK_HIGH)

// ---- p08 setup: the seller lists the file at the dust price (the first half
// of the frontend's linked two-transaction action) ----

const FK1 = cidFk('pub1')
await write(B, 'createRevision', [FK1, DUST, ZERO, ZERO, 0, 0, keccak256(toHex('')), 0n, '0x'])
const LID1 = lidOf(B.address, FK1)
const RID1 = await read('currentRevision', [LID1])
ok(RID1 === 1n, 'setup: dust listing revision=1')

// ---- p08 happy path ----

{
  const treasBefore = await A.publicClient.getBalance({ address: A.address })
  const bBefore = await bal(B)
  const rx = await write(B, 'publish', [B.address, LID1, RID1, mCid('pub1'), K1, SHA1, 1234n, 5300000n], DUST, PP, PUB_ADDR)
  const bAfter = await bal(B)
  // Fee + gas are the whole net cost; 90% of the dust returns in the same tx
  ok(bBefore - bAfter === gasOf(rx) + FEE, `p08 seller net = gas + platform fee (90% dust returned, delta=${bBefore - bAfter - gasOf(rx) - FEE})`)
  const treasAfter = await A.publicClient.getBalance({ address: A.address })
  ok(treasAfter - treasBefore === FEE, 'p08 treasury delta = the platform fee (exact)')
  const evs = pubEvents(rx).filter((e) => e.eventName === 'Published')
  ok(evs.length === 1, 'p08 exactly one Published event')
  const ev = evs[0].args
  ok(
    ev.fileKey === FK1 &&
      ev.seller?.toLowerCase() === B.address.toLowerCase() &&
      ev.manifestCid === mCid('pub1') &&
      ev.key.toLowerCase() === K1.toLowerCase() &&
      ev.plainSha256 === SHA1 &&
      ev.plainSize === 1234n &&
      ev.manifestHeightHint === 5300000n,
    'p08 all event fields correct (fileKey/seller/cid/key/plainSha256/size/heightHint)',
  )
  // The order is stored: buyer=publisher (the contract), price=1 wei
  const orderCount = await read('orderCount')
  const [orev, opr, , , , , obuyer, oseller] = await read('orderOf', [orderCount])
  ok(opr === DUST && orev === RID1 && obuyer?.toLowerCase() === PUB_ADDR.toLowerCase() && oseller?.toLowerCase() === B.address.toLowerCase(),
    'p08 order stored buyer=publisher · seller=B · price=DUST_PRICE')
  // fileKey = keccak256(manifestCid) (same derivation as the frontend fileKeyOf)
  ok((await read('currentRevision', [LID1])) === RID1, 'p08 currentRevision stays on the 1 wei revision')
}

// ---- p01 non-seller ----

await expectRevert(() => write(C, 'publish', [B.address, LID1, RID1, mCid('pub1'), K1, SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'NotListingSeller')
ok(true, 'p01 a non-seller call reverts (NotListingSeller)')

// ---- p02 listingId mismatch ----

const FK_OTHER = key('other')
await expectRevert(() => write(B, 'publish', [B.address, lidOf(B.address, FK_OTHER), RID1, mCid('pub1'), K1, SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'ListingMismatch')
ok(true, 'p02 a listingId mismatching (seller, keccak256(cid)) reverts (ListingMismatch)')

// ---- p03 unlisted (the listingId matches but no listing exists; purchase backstop NotListed) ----

await expectRevert(() => write(B, 'publish', [B.address, lidOf(B.address, cidFk('never')), 1n, mCid('never'), K2, SHA2, 1n, 1n], DUST, PP, PUB_ADDR), 'NotListed')
ok(true, 'p03 publish on an unlisted file reverts in purchase (NotListed)')

// ---- p04 value != 1 wei + a listing priced != 1 wei ----

await expectRevert(() => write(B, 'publish', [B.address, LID1, RID1, mCid('pub1'), K1, SHA1, 1n, 1n], DUST * 2n, PP, PUB_ADDR), 'WrongValue')
ok(true, 'p04a value=2xDUST reverts (WrongValue)')
await expectRevert(() => write(B, 'publish', [B.address, LID1, RID1, mCid('pub1'), K1, SHA1, 1n, 1n], 0n, PP, PUB_ADDR), 'WrongValue')
ok(true, 'p04b value=0 reverts (WrongValue)')
// A listing priced != 1 wei (the high-price listing): purchase's PriceTooHigh backstop
await expectRevert(() => write(B, 'publish', [B.address, LID_HIGH, 1n, mCid('high'), K2, SHA2, 1n, 1n], DUST, PP, PUB_ADDR), 'PriceTooHigh')
ok(true, 'p04c a high-price (!=1 wei) listing publish reverts in purchase (PriceTooHigh backstop)')

// ---- p05 stale revision ----

// Re-pricing = a new revision (the make-public flow re-prices on top of the dust listing)
await write(B, 'createRevision', [FK1, 5n, ZERO, ZERO, 0, 0, keccak256(toHex('')), 0n, '0x'])
await expectRevert(() => write(B, 'publish', [B.address, LID1, RID1, mCid('pub1'), K1, SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'NotCurrentRevision')
ok(true, 'p05 a stale revision (expected=1 < current=2) reverts (NotCurrentRevision)')
// Back to the dust price for the later scenarios (revision 3)
await write(B, 'createRevision', [FK1, DUST, ZERO, ZERO, 0, 0, keccak256(toHex('')), 0n, '0x'])
const RID3 = await read('currentRevision', [LID1])

// ---- p06 key length != 32 ----

await expectRevert(() => write(B, 'publish', [B.address, LID1, RID3, mCid('pub1'), K1 + '00', SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'BadKeyLength') // 33B
await expectRevert(() => write(B, 'publish', [B.address, LID1, RID3, mCid('pub1'), '0x1234', SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'BadKeyLength') // 2B
ok(true, 'p06 key lengths 33B/2B revert (BadKeyLength)')

// ---- p07 manifestCid over 128 ----

const longCid = 'b' + 'a'.repeat(128) // 129 chars
await expectRevert(() => write(B, 'publish', [B.address, lidOf(B.address, keccak256(toHex(longCid))), RID3, longCid, K1, SHA1, 1n, 1n], DUST, PP, PUB_ADDR), 'CidTooLong')
ok(true, 'p07 a 129-char manifestCid reverts (CidTooLong)')
const maxCid = 'b' + 'a'.repeat(127) // exactly 128, still valid
const FKMAX = keccak256(toHex(maxCid))
await write(B, 'createRevision', [FKMAX, DUST, ZERO, ZERO, 0, 0, keccak256(toHex('')), 0n, '0x'])
{
  const rx = await write(B, 'publish', [B.address, lidOf(B.address, FKMAX), 1n, maxCid, K2, SHA2, 8n, 8n], DUST, PP, PUB_ADDR)
  ok(pubEvents(rx).some((e) => e.eventName === 'Published' && e.args.manifestCid === maxCid), 'p07b exactly 128 chars passes (boundary)')
}

// ---- p09/p10 idempotency and regression ----

{
  // p09 republish: a second order + a second event (readers treat an existing event as a no-op)
  // (the reader no-ops when an event already exists)
  const ordersBefore = await read('orderCount')
  const b0 = await bal(B)
  const rx = await write(B, 'publish', [B.address, LID1, RID3, mCid('pub1'), K1, SHA1, 1234n, 5300000n], DUST, PP, PUB_ADDR)
  ok(b0 - (await bal(B)) === gasOf(rx) + FEE, 'p09 republish: seller net = gas + platform fee (exact)')
  ok((await read('orderCount')) === ordersBefore + 1n, 'p09 the second order increments independently (harmless)')
  ok(pubEvents(rx).filter((e) => e.eventName === 'Published').length === 1, 'p09 a second Published event')
}

{
  // p10 regression: both contract balances stay 0 (no standing funds),
  // buyerCount exactly +1, no rating-entry traces, the high-price listing
  // quote unaffected
  const pubBal = await A.publicClient.getBalance({ address: PUB_ADDR })
  const salesBal = await A.publicClient.getBalance({ address: SALES_ADDR })
  ok(pubBal === 0n && salesBal === 0n, 'p10 both contract balances stay 0 (no standing funds)')
  const [up, down, buyers] = await read('ratingOf', [LID1])
  ok(up === 0n && down === 0n && buyers === 1n, 'p10 buyerCount exactly +1 (publisher, deduped) · no ratings (no rate entry here)')
  const [priceHigh] = await read('revisionOf', [LID_HIGH, 1n])
  ok(priceHigh === 10n ** 17n, 'p10 the high-price listing quote is unaffected by the dust-price public file')
  const treas = await read('treasury')
  ok(treas?.toLowerCase() === A.address.toLowerCase(), 'p10b treasury sanity (receives only the platform fees)')
}

// ---- p11 sales() immutable readback + bytecode equality ----

{
  const salesOn = await read('sales', [], PP, PUB_ADDR)
  ok(salesOn?.toLowerCase() === SALES_ADDR.toLowerCase(), 'p11 sales() readback == the DirectSales instance (trust domain welded)')
  // Bytecode equality: the deployedBytecode immutable placeholders are patched with the constructor args
  const path = await import('../p3/lib/chain.mjs')
  const expectedCode = path.patchImmutablesMulti(PUB, { sales: SALES_ADDR })
  const onchain = await A.publicClient.getCode({ address: PUB_ADDR })
  ok(onchain?.toLowerCase() === expectedCode.toLowerCase(), 'p11 on-chain code equals the artifact byte-for-byte (after the immutable patch)')
}

console.log(`\n${passed} assertions passed`)
await cleanup()
process.exit(0)
