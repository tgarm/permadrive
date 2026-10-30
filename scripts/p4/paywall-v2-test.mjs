// PaywallV2 offline adversarial tests (order-model redesign) — local ganache EVM
// (npm devDependency), zero mainnet funds, evm_increaseTime time travel built in.
//   node paywall-v2-test.mjs            # starts/stops an in-process ganache node
//   LOCAL_EVM_RPC=http://127.0.0.1:8545 node paywall-v2-test.mjs   # reuse a running node
//
// Scenarios (A = seller/treasury/owner, B = attacker, C = buyer):
//   t01 happy path (list → buy with overpay refund → deliver → release after
//       grace → fee/credits → withdraw)
//   t02 overwrite attack: B calling setPrice on the same key only creates B's own
//       listing; B cannot markDelivered/release A's order; buyer confirmReceipt
//       settles to the order's snapshot seller A; credits[B] === 0
//   t03 front-running a key: B listing first doesn't block A listing the same key
//   t04 repricing after purchase doesn't affect the order (price/fee snapshot);
//       later owner setFeeBps doesn't affect existing orders
//   t05 delisting after purchase: new purchases revert; the escrowed order can
//       still deliver/release/refund (v1 froze funds here)
//   t06 relisting after delisting leaves the old order untouched
//   t07 buyer confirmReceipt directly on Escrowed (voluntary payout)
//   t08 maxPrice bound: after a price increase, maxPrice = old price → PriceTooHigh
//   t09 refund after deliveryTimeout (Escrowed)
//   t10 within grace period refund OK; after grace refund reverts, release works
//   t11 repurchase after Refunded gets a new orderId; history preserved
//   t12 global fund conservation: contract balance === Σcredits + Σescrow (both trees share the coverage list; English mirror)
//
// Balance assertions follow the treasury==signer rule: never assert the signer's
// native balance delta (gas mixes in) — assert credits (storage) and event args
// (net/fee) instead; contract-level conservation is covered by t12.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/PaywallV2.json', import.meta.url).pathname, 'utf8'))
// "test test …" mnemonic — prefunded identically by ganache and anvil defaults
const MNEMONIC = 'test test test test test test test test test test test junk'

// ---- local EVM lifecycle (in-process ganache by default; LOCAL_EVM_RPC attaches an external node) ----

const EXTERNAL_RPC = process.env.LOCAL_EVM_RPC || process.env.ANVIL_RPC || null
let server = null
let rpcUrl = EXTERNAL_RPC
if (!rpcUrl) {
  const ganache = (await import('ganache')).default
  const port = 46000 + Math.floor(Math.random() * 8000)
  server = ganache.server({ chain: { chainId: 1337 }, wallet: { mnemonic: MNEMONIC }, logging: { quiet: true } })
  await server.listen(port)
  rpcUrl = `http://127.0.0.1:${port}`
}
// ganache's close() is known to throw on the exit path — swallow it; process
// teardown reclaims everything anyway
const cleanup = async () => { if (server) { try { await server.close() } catch { /* ignore */ } server = null } }
process.on('SIGINT', () => { void cleanup(); process.exit(130) })

// ---- viem clients (three accounts derived from the shared mnemonic) ----

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
const A = clientFor(0) // seller / treasury / owner
const B = clientFor(1) // attacker
const C = clientFor(2) // buyer
console.log('local evm:', rpcUrl)
console.log('A (seller/treasury):', A.address)
console.log('B (attacker)       :', B.address)
console.log('C (buyer)          :', C.address)

// ---- deploy (deliveryTimeout 60s / gracePeriod 60s, paired with time travel) ----

const TIMEOUT = 60n
const GRACE = 60n
const hash = await A.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [A.address, TIMEOUT, GRACE], chain: localChain })
const deployRx = await A.publicClient.waitForTransactionReceipt({ hash })
if (deployRx.status !== 'success') throw new Error('deploy failed')
const PC = artifact.abi
const ADDR = deployRx.contractAddress
console.log('PaywallV2:', ADDR, `· block ${deployRx.blockNumber} · gas ${deployRx.gasUsed}`)

const read = (fn, args = []) => A.publicClient.readContract({ address: ADDR, abi: PC, functionName: fn, args })
async function write(c, fn, args = [], value = 0n) {
  const h = await c.walletClient.writeContract({ address: ADDR, abi: PC, functionName: fn, args, chain: localChain, ...(value ? { value } : {}) })
  const rx = await c.publicClient.waitForTransactionReceipt({ hash: h })
  if (rx.status !== 'success') throw new Error(`${fn} tx ${rx.status}`)
  return rx
}
const gasOf = (rx) => rx.gasUsed * (rx.effectiveGasPrice ?? 0n)
const bal = (c) => c.publicClient.getBalance({ address: c.address })
const key = (tag) => keccak256(toHex(`paywall-v2-test-${tag}`))
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
// ganache reverts carry only the 4-byte selector (no error name) — build a
// selector→name map and match either the name or the selector hex
const errSel = {}
for (const item of PC) {
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
const travel = async (seconds) => {
  await A.publicClient.request({ method: 'evm_increaseTime', params: [Number(seconds)] })
  await A.publicClient.request({ method: 'evm_mine' })
}

// ---- assertions ----

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

const PRICE = 10n ** 16n // 0.01 ETH (local)
const FEE0 = 1000 // default feeBps (uint16 decodes to number via viem)

// order(id) helper — public struct getter returns an unnamed tuple
async function order(id) {
  const [seller, buyer, price, feeBps, state, purchasedAt, deliveredAt] = await read('orders', [id])
  return { seller, buyer, price, feeBps, state, purchasedAt, deliveredAt }
}

// ---- t01 happy path ----
{
  const k = key('t01')
  await write(A, 'setPrice', [k, PRICE])
  ok((await read('listingPrice', [A.address, k])) === PRICE, 't01 listing readback (seller namespace)')
  const c0 = await bal(C)
  const rx = await write(C, 'purchase', [k, A.address, PRICE], PRICE + 10n ** 15n)
  const c1 = await bal(C)
  ok(c0 - c1 === PRICE + gasOf(rx), 't01 purchase: Escrowed, overpay refunded (net spend = price + gas)')
  const o = await order(1n)
  ok(o.state === 1 && o.price === PRICE && o.buyer === C.address && o.seller === A.address && o.feeBps === FEE0, 't01 order(1) readback: snapshot complete')
  // Note: v2 has no AlreadyPaid — repurchasing the same key+buyer creates a new order (legal; covered by t11)

  await write(A, 'markDelivered', [1n])
  ok((await order(1n)).state === 2, 't01 markDelivered: Delivered')
  await travel(GRACE + 1n)
  const relRx = await write(A, 'release', [1n])
  const ev = relRx.logs.map((l) => { try { return decodeEventLog({ abi: PC, data: l.data, topics: l.topics }) } catch { return null } }).filter(Boolean)
  const released = ev.find((e) => e.eventName === 'Released')
  const fee = (PRICE * BigInt(FEE0)) / 10000n
  ok(released && released.args.net === PRICE - fee && released.args.fee === fee, `t01 release: fee ${fee} → treasury, net ${PRICE - fee} → credits`)
  ok((await order(1n)).state === 3, 't01 Released terminal state')
  ok((await read('credits', [A.address])) === PRICE - fee, 't01 credits[A] = price - fee')
  const before = await read('credits', [A.address])
  await write(A, 'withdraw')
  ok((await read('credits', [A.address])) === 0n, 't01 withdraw zeroes credits')
  ok(before > 0n, 't01 withdraw paid out a non-zero amount')
}

// ---- t02 overwrite attack ----
{
  const k = key('t02')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  const orderId = 2n
  ok((await order(orderId)).seller === A.address, 't02 C purchased from A (orderId=2)')
  // Attacker B "re-lists" the same key — v2 only writes B's own namespace
  await write(B, 'setPrice', [k, PRICE * 2n])
  ok((await read('listingPrice', [A.address, k])) === PRICE, 't02 A listing not overwritten')
  ok((await read('listingPrice', [B.address, k])) === PRICE * 2n, 't02 B only created an independent listing of its own')
  // B cannot touch A's order
  await expectRevert(() => write(B, 'markDelivered', [orderId]), 'NotSeller')
  ok(true, 't02 B markDelivered(A order) rejected (order snapshot seller)')
  await expectRevert(() => write(B, 'release', [orderId]), 'NotSeller')
  ok(true, 't02 B release(A order) rejected')
  // Buyer confirms while B holds a listing on the same key → settles to snapshot seller A, not B
  await write(C, 'confirmReceipt', [orderId])
  ok((await order(orderId)).state === 3, 't02 buyer confirmReceipt → Released')
  ok((await read('credits', [B.address])) === 0n, 't02 credits[B] === 0 (zero-address/attacker credit impossible)')
  ok((await read('credits', [A.address])) > 0n, 't02 credits settled to the order seller A')
}

// ---- t03 front-running a key ----
{
  const k = key('t03')
  await write(B, 'setPrice', [k, PRICE])
  await write(A, 'setPrice', [k, PRICE * 3n])
  ok((await read('listingPrice', [B.address, k])) === PRICE && (await read('listingPrice', [A.address, k])) === PRICE * 3n, 't03 two sellers coexist on one key without overwriting each other')
  await write(C, 'purchase', [k, A.address, PRICE * 3n], PRICE * 3n)
  const o = await order(3n)
  ok(o.seller === A.address && o.price === PRICE * 3n, 't03 buyer explicitly bought from A')
  await expectRevert(() => write(B, 'markDelivered', [3n]), 'NotSeller')
  ok(true, 't03 B cannot touch A order')
  await write(C, 'confirmReceipt', [3n])
  ok((await read('credits', [B.address])) === 0n, 't03 B earned nothing')
}

// ---- t04 repricing after purchase / owner fee change (snapshot holds) ----
{
  const k = key('t04')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(A, 'setPrice', [k, PRICE * 2n])
  await write(A, 'setFeeBps', [0])
  const o = await order(4n)
  ok(o.price === PRICE && o.feeBps === FEE0, 't04 after reprice/fee change: order snapshot unchanged')
  await write(A, 'markDelivered', [4n])
  await travel(GRACE + 1n)
  // credits accumulate across scenarios — assert the increment (snapshot feeBps=1000 → net 0.9P)
  const c0 = await read('credits', [A.address])
  await write(A, 'release', [4n])
  ok((await read('credits', [A.address])) - c0 === (PRICE * 9n) / 10n, 't04 settled at snapshot feeBps=1000 (not current 0; increment 0.9P)')
}

// ---- t05 delisting after purchase: escrowed order unaffected (v1 froze funds here) ----
{
  const k = key('t05')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(A, 'setPrice', [k, 0n])
  ok((await read('listingPrice', [A.address, k])) === 0n, 't05 delisted: listing cleared')
  await expectRevert(() => write(C, 'purchase', [k, A.address, PRICE], PRICE), 'NotListed')
  ok(true, 't05 new purchase after delist rejected')
  await write(A, 'markDelivered', [5n])
  await travel(GRACE + 1n)
  await write(A, 'release', [5n])
  ok((await order(5n)).state === 3, 't05 escrowed order deliver/release unaffected by delist')
}

// ---- t06 relisting after delisting: old order state untouched ----
{
  const k = key('t06')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(A, 'setPrice', [k, 0n])
  await write(A, 'setPrice', [k, PRICE * 5n])
  const o = await order(6n)
  ok(o.state === 1 && o.price === PRICE, 't06 after relist, old order: Escrowed with old price snapshot')
  // credits accumulate across scenarios — assert the increment (order 6 was
  // purchased after t04 lowered the fee: snapshot feeBps=0 → full price)
  const c0 = await read('credits', [A.address])
  await write(C, 'confirmReceipt', [6n])
  ok((await read('credits', [A.address])) - c0 === PRICE, 't06 old order settled at old price snapshot + snapshot fee rate to A (increment = full price, snapshot feeBps=0)')
}

// ---- t07 buyer confirms directly on Escrowed ----
{
  const k = key('t07')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(C, 'confirmReceipt', [7n])
  ok((await order(7n)).state === 3, 't07 confirmReceipt directly on Escrowed (voluntary payout)')
}

// ---- t08 maxPrice bound ----
{
  const k = key('t08')
  await write(A, 'setPrice', [k, PRICE])
  await write(A, 'setPrice', [k, PRICE * 2n]) // price raised after viewing
  await expectRevert(() => write(C, 'purchase', [k, A.address, PRICE], PRICE * 2n), 'PriceTooHigh')
  ok(true, 't08 maxPrice = old price → PriceTooHigh (blocks price change between view and sign)')
  await write(C, 'purchase', [k, A.address, PRICE * 2n], PRICE * 2n)
  ok((await order(8n)).price === PRICE * 2n, 't08 maxPrice = current price → purchase succeeds')
}

// ---- t09 Escrowed timeout refund ----
{
  const k = key('t09')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await expectRevert(() => write(C, 'refund', [9n]), 'BadState')
  ok(true, 't09 refund before timeout rejected')
  await travel(TIMEOUT + 1n)
  const c0 = await bal(C)
  const rx = await write(C, 'refund', [9n])
  const c1 = await bal(C)
  ok(c1 - c0 === PRICE - gasOf(rx), 't09 timeout refund: full amount (net = price - gas)')
  ok((await order(9n)).state === 4, 't09 Refunded terminal state')
}

// ---- t10 Delivered grace-period boundary ----
{
  const k = key('t10a')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(A, 'markDelivered', [10n])
  await travel(GRACE - 5n)
  await write(C, 'refund', [10n])
  ok((await order(10n)).state === 4, 't10a refund within grace period OK')
}
{
  const k = key('t10b')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await write(A, 'markDelivered', [11n])
  await travel(GRACE + 1n)
  await expectRevert(() => write(C, 'refund', [11n]), 'BadState')
  ok(true, 't10b buyer refund after grace rejected')
  await write(A, 'release', [11n])
  ok((await order(11n)).state === 3, 't10b seller release after grace succeeds')
}

// ---- t11 repurchase after Refunded: new orderId, history preserved ----
{
  const k = key('t11')
  await write(A, 'setPrice', [k, PRICE])
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  await travel(TIMEOUT + 1n)
  await write(C, 'refund', [12n])
  const before = await read('orderCount')
  await write(C, 'purchase', [k, A.address, PRICE], PRICE)
  const newId = await read('orderCount')
  ok(newId === before + 1n, 't11 repurchase creates a new orderId (independent order identity)')
  ok((await order(12n)).state === 4, 't11 historical order stays Refunded')
  const o = await order(newId)
  ok(o.state === 1 && o.price === PRICE, 't11 new order Escrowed')
  await write(C, 'confirmReceipt', [newId])
  ok((await order(newId)).state === 3, 't11 new order settles normally')
}

// ---- t12 global fund conservation ----
{
  const contractBal = await A.publicClient.getBalance({ address: ADDR })
  const count = Number(await read('orderCount'))
  let escrow = 0n
  for (let i = 1; i <= count; i++) {
    const o = await order(BigInt(i))
    if (o.state === 1 || o.state === 2) escrow += o.price
  }
  let credits = 0n
  for (const c of [A, B, C]) credits += await read('credits', [c.address])
  ok(contractBal === escrow + credits, `t12 conservation: contract balance ${contractBal} === Σescrow ${escrow} + Σcredits ${credits} (${count} orders)`)
  ok((await read('credits', [B.address])) === 0n, 't12 attacker B earned nothing end to end')
}

await cleanup()
console.log(`\nAll ${passed} assertions passed ✓ (PaywallV2 adversarial tests)`)
process.exit(0)
