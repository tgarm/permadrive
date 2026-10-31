// PaywallV2 mainnet selftest (order-model redesign). Real transactions; rerun
// with fresh keys. Prerequisite: deploy-paywall-v2.mjs executed first
// (deployments.json contains paywall-v2(-test) keys).
//   node paywall-v2.mjs
//
// Test instance (5 min / 5 min) walks the full state machine + adversarial
// scenarios: list → purchase (overpay refunded) → attacker re-lists the same key
// (only creates its own listing) → attacker markDelivered/release rejected →
// refund before timeout rejected → deliver → refund within grace (full) →
// repurchase after refund (new orderId, history preserved) → deliver → wait out
// the grace period → refund rejected → buyer confirms while the attacker still
// holds a listing → settles to the snapshot seller → seller release (fee →
// treasury, net → credits) → credits[attacker] === 0 → withdraw. Main instance
// (3 days / 3 days) walks the confirmReceipt happy path self-trade (net spend =
// fee + gas).
// Balance assertions follow the treasury==signer rule (net/increment accounting).
// For fast offline regression incl. time-traveled timeout paths use
// paywall-v2-test.mjs (anvil, zero funds).
// doc/14 §5 fixes: (1) uint8/uint16 unified to the number decoding rule (pit 26);
// (2) orderId parsed from the purchase receipt's Purchased event (never orderCount);
// (3) withdraw asserted against the total credits baseline taken right before it
// (credits added by the orderId3 confirmation are no longer masked).

import { readFileSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'
import { decodeEventLog, keccak256, toHex } from 'viem'

const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const MAIN = deployments['auto-evm-mainnet-paywall-v2']
const TEST = deployments['auto-evm-mainnet-paywall-v2-test']
if (!MAIN || !TEST) throw new Error('deployments.json missing paywall-v2 instances — run node deploy-paywall-v2.mjs first')
const abis = JSON.parse(readFileSync(new URL('../../contracts/out/PaywallV2.json', import.meta.url).pathname, 'utf8')).abi

const A = clients(0) // seller / owner / treasury
const B = clients(1) // attacker
const Bu = clients(2) // buyer (v2 scenarios need a buyer separate from the attacker)
console.log('A (seller/treasury):', A.address, '·', ai3(await A.publicClient.getBalance({ address: A.address })))
console.log('B (attacker)       :', B.address, '·', ai3(await B.publicClient.getBalance({ address: B.address })))
console.log('C (buyer)          :', Bu.address, '·', ai3(await Bu.publicClient.getBalance({ address: Bu.address })))
console.log('main:', MAIN.address, '· test:', TEST.address)

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const bal = (c) => c.publicClient.getBalance({ address: c.address })
const gasOf = (receipt) => receipt.gasUsed * receipt.effectiveGasPrice
const key = (tag) => keccak256(toHex(`p4-paywall-v2-selftest-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`))

async function write(c, contract, fn, args, value = 0n) {
  const hash = await c.walletClient.writeContract({ address: contract, abi: abis, functionName: fn, args, chain: autoEvm, ...(value ? { value } : {}) })
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(`${fn} tx ${receipt.status}`)
  return receipt
}

async function expectRevert(factory, reason) {
  try {
    await factory()
  } catch (e) {
    if (new RegExp(reason).test(String(e.message))) return
    throw new Error(`expected revert(${reason}) but got: ${String(e.message).split('\n')[0].slice(0, 160)}`)
  }
  throw new Error(`expected revert(${reason}) but the transaction succeeded`)
}

const read = (c, contract, fn, args = []) => c.publicClient.readContract({ address: contract, abi: abis, functionName: fn, args })
// public struct getter (orders) returns an unnamed tuple — destructure positionally.
// doc/14 §5-1: uint8/uint16 decode as number in viem (pit 26) — normalize to the
// number rule instead of failing correct on-chain results via bigint comparisons.
async function orderOf(c, contract, id) {
  const [seller, buyer, price, feeBps, state] = await read(c, contract, 'orders', [id])
  return { seller, buyer, price, feeBps: Number(feeBps), state: Number(state) }
}
// doc/14 §5-2: orderId always parsed from the purchase receipt's Purchased event
// (indexed orderId), never inferred from orderCount — concurrent purchases change it.
function orderIdFromReceipt(rx) {
  for (const log of rx.logs) {
    try {
      const ev = decodeEventLog({ abi: abis, data: log.data, topics: log.topics })
      if (ev.eventName === 'Purchased') return ev.args.orderId
    } catch { /* other contract / other event, skip */ }
  }
  throw new Error('receipt has no Purchased event (contract address / ABI mismatch?)')
}

const PRICE = 1n * 10n ** 16n // 0.01 AI3
const FEE_BPS = 1000 // default feeBps (uint16 → number); use BigInt(FEE_BPS) in money math

// ---------- test instance: full state machine + adversarial scenarios ----------
{
  const C = TEST.address
  const key1 = key('adversarial')
  const setRx = await write(A, C, 'setPrice', [key1, PRICE])
  ok((await read(A, C, 'listingPrice', [A.address, key1])) === PRICE, `listing readback (seller namespace, gas ${Number(setRx.gasUsed)})`)

  // purchase: 0.001 AI3 overpay must be fully refunded (Bu net = -price - gas)
  const b0 = await bal(Bu)
  const buyRx = await write(Bu, C, 'purchase', [key1, A.address, PRICE], PRICE + 10n ** 15n)
  const b1 = await bal(Bu)
  ok(b0 - b1 === PRICE + gasOf(buyRx), `purchase: Escrowed, overpay refunded (net spend = price + gas)`)
  const orderId1 = orderIdFromReceipt(buyRx)
  const o1 = await orderOf(A, C, orderId1)
  ok(o1.state === 1 && o1.price === PRICE && o1.seller === A.address && o1.buyer === Bu.address && o1.feeBps === FEE_BPS, `order(${orderId1}) readback: snapshot complete (uint8/uint16 as number, pit 26)`)

  // attacker re-lists the same key: only its own namespace, A's listing and orders untouched
  await write(B, C, 'setPrice', [key1, PRICE * 2n])
  ok((await read(A, C, 'listingPrice', [A.address, key1])) === PRICE, "A listing unchanged after attacker's setPrice")
  ok((await read(A, C, 'listingPrice', [B.address, key1])) === PRICE * 2n, 'attacker only holds an independent listing')
  await expectRevert(() => write(B, C, 'markDelivered', [orderId1]), 'NotSeller')
  ok(true, 'attacker markDelivered(A order) rejected (order snapshot seller)')
  await expectRevert(() => write(B, C, 'release', [orderId1]), 'NotSeller')
  ok(true, 'attacker release(A order) rejected')
  await expectRevert(() => write(Bu, C, 'refund', [orderId1]), 'BadState')
  ok(true, 'refund before timeout rejected (Escrowed < deliveryTimeout)')

  // deliver → refund within grace period (full, Bu net = +price - gas)
  await write(A, C, 'markDelivered', [orderId1])
  ok((await orderOf(A, C, orderId1)).state === 2, 'markDelivered: Delivered')
  const b2 = await bal(Bu)
  const refundRx = await write(Bu, C, 'refund', [orderId1])
  const b3 = await bal(Bu)
  ok(b3 - b2 === PRICE - gasOf(refundRx), 'refund within grace: full refund to buyer')
  ok((await orderOf(A, C, orderId1)).state === 4, 'order state: Refunded (history preserved)')

  // buyer repurchases while the attacker is still listed: new orderId (parsed from the receipt,
  // not read off orderCount), settlement still to the snapshot seller
  const buyRx2 = await write(Bu, C, 'purchase', [key1, A.address, PRICE], PRICE)
  const orderId2 = orderIdFromReceipt(buyRx2)
  ok(orderId2 > orderId1, 'repurchase creates a new orderId (independent order identity)')
  ok((await orderOf(A, C, orderId1)).state === 4 && (await orderOf(A, C, orderId2)).state === 1, 'historical Refunded + new Escrowed coexist')

  await write(A, C, 'markDelivered', [orderId2])
  // grace period (5 minutes) later: buyer refund rejected, seller release pays out
  console.log('… waiting out the grace period (5 minutes, test instance)')
  await new Promise((r) => setTimeout(r, 5 * 60 * 1000 + 15 * 1000))
  await expectRevert(() => write(Bu, C, 'refund', [orderId2]), 'BadState')
  ok(true, 'buyer refund after grace rejected (Delivered ≥ gracePeriod)')

  // credits accumulate across selftest rounds — always assert increments
  const creditsBefore = await read(A, C, 'credits', [A.address])
  const relRx = await write(A, C, 'release', [orderId2])
  ok((await orderOf(A, C, orderId2)).state === 3, 'release: Released')
  const expectedNet = (PRICE * (10000n - BigInt(FEE_BPS))) / 10000n
  const expectedFee = PRICE - expectedNet
  const relEvents = relRx.logs.map((l) => { try { return decodeEventLog({ abi: abis, data: l.data, topics: l.topics }) } catch { return null } }).filter(Boolean)
  const released = relEvents.find((e) => e.eventName === 'Released')
  ok(released && released.args.net === expectedNet && released.args.fee === expectedFee, `Released event: net ${ai3(expectedNet)} / fee ${ai3(expectedFee)} (snapshot feeBps)`)
  const creditsAfter = await read(A, C, 'credits', [A.address])
  ok(creditsAfter - creditsBefore === expectedNet, `credits increment = price × 90% = ${ai3(expectedNet)} (snapshot feeBps)`)
  ok((await read(A, C, 'credits', [B.address])) === 0n, 'attacker earned nothing (zero-address/overwrite credit impossible)')
  await expectRevert(() => write(Bu, C, 'refund', [orderId2]), 'BadState')
  ok(true, 'refund after Released rejected')

  // maxPrice bound: after a price increase, maxPrice = old price → PriceTooHigh
  const key2 = key('maxprice')
  await write(A, C, 'setPrice', [key2, PRICE])
  await write(A, C, 'setPrice', [key2, PRICE * 2n])
  await expectRevert(() => write(Bu, C, 'purchase', [key2, A.address, PRICE], PRICE * 2n), 'PriceTooHigh')
  ok(true, 'maxPrice = old price → PriceTooHigh rejected')
  const buyRx3 = await write(Bu, C, 'purchase', [key2, A.address, PRICE * 2n], PRICE * 2n)
  const orderId3 = orderIdFromReceipt(buyRx3)
  ok((await orderOf(A, C, orderId3)).price === PRICE * 2n, 'maxPrice = current price → purchase succeeds (new price snapshot)')
  await write(A, C, 'setPrice', [key2, 0n]) // delist cleanup (escrowed order unaffected)
  await write(Bu, C, 'confirmReceipt', [orderId3])

  // doc/14 §5-3: the orderId3 confirmation already credited A — assert the
  // withdrawal against the total credits taken right before it (never reuse one
  // order's increment, and never mask mixed credits with a balance-diff shortcut)
  const creditsBeforeWithdraw = await read(A, C, 'credits', [A.address])
  const a1 = await bal(A)
  const wdRx = await write(A, C, 'withdraw', [])
  ok((await bal(A)) - a1 + gasOf(wdRx) === creditsBeforeWithdraw, `withdraw: pre-withdraw total ${ai3(creditsBeforeWithdraw)} received (incl. orderId2/orderId3 net)`)
  await expectRevert(() => write(A, C, 'withdraw', []), 'NothingToWithdraw')
  ok(true, 'double withdrawal rejected (NothingToWithdraw)')

  // feeBps permission surface (uint16 → number rule, pit 26)
  await write(A, C, 'setFeeBps', [500n])
  ok(Number(await read(A, C, 'feeBps')) === 500, 'owner setFeeBps 500')
  await expectRevert(() => write(B, C, 'setFeeBps', [500n]), 'NotOwner')
  ok(true, 'non-owner setFeeBps rejected')
  await expectRevert(() => write(A, C, 'setFeeBps', [2001n]), 'FeeTooHigh')
  ok(true, 'fee above cap rejected (MAX_FEE_BPS=2000)')
  await write(A, C, 'setFeeBps', [1000n])
}

// ---------- main instance: confirmReceipt happy path (self-trade, net = fee + gas) ----------
{
  const C = MAIN.address
  const keyM = key('v2-main-happy')
  await write(A, C, 'setPrice', [keyM, PRICE])
  const creditsBefore = await read(A, C, 'credits', [A.address])
  const a0 = await bal(A)
  const buyRxM = await write(A, C, 'purchase', [keyM, A.address, PRICE], PRICE)
  const orderId = orderIdFromReceipt(buyRxM)
  ok((await orderOf(A, C, orderId)).state === 1, 'main instance self-purchase: Escrowed (self-trade allowed)')
  await write(A, C, 'markDelivered', [orderId])
  await write(A, C, 'confirmReceipt', [orderId])
  ok((await orderOf(A, C, orderId)).state === 3, 'main instance confirmReceipt: Released')
  const expectedNet = (PRICE * (10000n - BigInt(FEE_BPS))) / 10000n
  const creditsAfter = await read(A, C, 'credits', [A.address])
  ok(creditsAfter - creditsBefore === expectedNet, `main instance credits increment = ${ai3(expectedNet)} (fee went straight to treasury=self)`)
  // same pre-withdraw baseline rule on the main instance (historic credits must not be masked)
  const creditsBeforeWdM = await read(A, C, 'credits', [A.address])
  const aWd = await bal(A)
  const wdRxM = await write(A, C, 'withdraw', [])
  ok((await bal(A)) - aWd + gasOf(wdRxM) === creditsBeforeWdM, `main instance withdraw: pre-withdraw credits ${ai3(creditsBeforeWdM)} fully received`)
  const spent = a0 - (await bal(A))
  ok(spent < gasOf({ gasUsed: 2_000_000n, effectiveGasPrice: 10_700_000_000n }), `self-trade total net spend ≈ gas (fee/net self-transferred, actual ${ai3(spent)})`)
  await write(A, C, 'setPrice', [keyM, 0n]) // delist cleanup
}

console.log(`\nAll ${passed} checks passed (real mainnet transactions; fresh keys per round)`)
