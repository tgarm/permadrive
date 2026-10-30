// Paywall mainnet selftest. Real transactions; every run uses fresh keys.
//   node paywall.mjs
//
// The test instance (5 min/5 min) walks the full state machine: list →
// purchase (overpayment refunded) → duplicate purchase rejected → refund
// before the timeout rejected → deliver → refund within grace (full) →
// re-purchase after refund → deliver → refund after grace rejected → seller
// release (fee → treasury, net into credits) → withdraw. The main instance
// (3 d/3 d) walks the confirmReceipt happy path as a self-trade (net spend =
// fee + gas). Balance assertions use net deltas — when treasury == signer the
// fee comes back to the same account, so naive increment expectations miss it.

import { readFileSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3, patchImmutablesMulti } from '../p3/lib/chain.mjs'
import { keccak256, toHex } from 'viem'

const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const MAIN = deployments['auto-evm-mainnet-paywall']
const TEST = deployments['auto-evm-mainnet-paywall-test']
if (!MAIN || !TEST) throw new Error('deployments.json is missing the paywall instances — run the paywall deploy first')
const abis = JSON.parse(readFileSync(new URL('../../contracts/out/Paywall.json', import.meta.url).pathname, 'utf8')).abi

const A = clients(0) // seller / owner / treasury
const B = clients(1) // buyer
console.log('A (seller/treasury):', A.address, '·', ai3(await A.publicClient.getBalance({ address: A.address })))
console.log('B (buyer)         :', B.address, '·', ai3(await B.publicClient.getBalance({ address: B.address })))
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
const key = (tag) => keccak256(toHex(`p4-paywall-selftest-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`))

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
  throw new Error(`expected revert(${reason}) but the tx succeeded`)
}

const PRICE = 1n * 10n ** 16n // 0.01 AI3
const FEE_BPS = 1000n

// ---------- test instance: full state machine ----------
{
  const C = TEST.address
  const key1 = key('refund-path')
  const setRx = await write(A, C, 'setPrice', [key1, PRICE])
  const listing = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'listings', args: [key1] })
  // a public mapping getter returns the struct as an unnamed tuple (solc emits no component names)
  ok(listing[0].toLowerCase() === A.address.toLowerCase() && listing[1] === PRICE, `listing readback (gas ${Number(setRx.gasUsed)})`)

  // purchase: the extra 0.001 AI3 must come back (B's net change = -price - gas)
  const b0 = await bal(B)
  const buyRx = await write(B, C, 'purchase', [key1], PRICE + 10n ** 15n)
  const b1 = await bal(B)
  ok(b0 - b1 === PRICE + gasOf(buyRx), `purchase: Escrowed, overpayment refunded (net spend = price + gas)`)
  let deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [key1, B.address] })
  ok(deal.state === 1 && deal.price === PRICE, `deal readback: Escrowed, price snapshot ${ai3(deal.price)}`)

  await expectRevert(() => write(B, C, 'purchase', [key1], PRICE), 'AlreadyPaid')
  ok(true, 'duplicate purchase rejected (AlreadyPaid)')
  await expectRevert(() => write(B, C, 'refund', [key1]), 'BadState')
  ok(true, 'refund before the timeout rejected (Escrowed < deliveryTimeout)')
  await expectRevert(() => write(B, C, 'markDelivered', [key1, B.address]), 'NotSeller')
  ok(true, 'markDelivered by a non-seller rejected (NotSeller)')

  // deliver → refund within grace (full refund; B's net change = +price - gas)
  await write(A, C, 'markDelivered', [key1, B.address])
  deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [key1, B.address] })
  ok(deal.state === 2, 'markDelivered：Delivered')
  const b2 = await bal(B)
  const refundRx = await write(B, C, 'refund', [key1])
  const b3 = await bal(B)
  ok(b3 - b2 === PRICE - gasOf(refundRx), 'refund within grace: full refund to the buyer')
  deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [key1, B.address] })
  ok(deal.state === 4, 'deal state: Refunded')

  // re-purchase after a refund (Refunded → re-ordering allowed)
  await write(B, C, 'purchase', [key1], PRICE)
  deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [key1, B.address] })
  ok(deal.state === 1 && deal.purchasedAt > 0n, 're-purchase after refund: a fresh Escrowed round')
  await write(A, C, 'markDelivered', [key1, B.address])

  // after the grace period (5 min): the buyer's refund is rejected, the seller releases
  console.log('… waiting out the grace period (5 minutes, test instance)')
  await new Promise((r) => setTimeout(r, 5 * 60 * 1000 + 15 * 1000))
  await expectRevert(() => write(B, C, 'refund', [key1]), 'BadState')
  ok(true, 'refund after grace rejected (Delivered ≥ gracePeriod)')

  const a0 = await bal(A)
  // credits is a cumulative value (across selftest rounds) — assert deltas only
  const creditsBefore = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'credits', args: [A.address] })
  const relRx = await write(A, C, 'release', [key1, B.address])
  deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [key1, B.address] })
  ok(deal.state === 3, 'release：Released')
  // treasury == seller == signer — the fee is pushed to treasury (= self) in
  // the same tx, so A's balance changes by +fee − gas; the net (price − fee)
  // lands in credits
  const fee = (PRICE * FEE_BPS) / 10000n
  const expectedNet = (PRICE * (10000n - FEE_BPS)) / 10000n
  ok((await bal(A)) - a0 + gasOf(relRx) === fee, 'settle: the fee goes straight to treasury (= self; balance +fee−gas)')
  const creditsAfter = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'credits', args: [A.address] })
  ok(creditsAfter - creditsBefore === expectedNet, `credits delta = price × 90% = ${ai3(expectedNet)}`)

  // withdraw (pull): pulls the full accumulated credits (earlier rounds included)
  const a1 = await bal(A)
  const wdRx = await write(A, C, 'withdraw', [])
  ok((await bal(A)) - a1 + gasOf(wdRx) === creditsAfter, `withdraw: accumulated net ${ai3(creditsAfter)} lands`)
  await expectRevert(() => write(A, C, 'withdraw', []), 'NothingToWithdraw')
  ok(true, 'second withdraw rejected (NothingToWithdraw)')
  await expectRevert(() => write(B, C, 'refund', [key1]), 'BadState')
  ok(true, 'refund after Released rejected')

  // feeBps permission surface
  await write(A, C, 'setFeeBps', [500n])
  ok((await A.publicClient.readContract({ address: C, abi: abis, functionName: 'feeBps' })) === 500n, 'owner setFeeBps 500')
  await expectRevert(() => write(B, C, 'setFeeBps', [500n]), 'NotOwner')
  ok(true, 'setFeeBps by a non-owner rejected')
  await expectRevert(() => write(A, C, 'setFeeBps', [2001n]), 'FeeTooHigh')
  ok(true, 'fee above the cap rejected (MAX_FEE_BPS = 2000)')
  await write(A, C, 'setFeeBps', [1000n])
}

// ---------- main instance: the confirmReceipt happy path (self-trade) ----------
{
  const C = MAIN.address
  const keyM = key('main-happy')
  await write(A, C, 'setPrice', [keyM, PRICE])
  const creditsBefore = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'credits', args: [A.address] })
  const a0 = await bal(A)
  await write(A, C, 'purchase', [keyM], PRICE)
  let deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [keyM, A.address] })
  ok(deal.state === 1, 'main-instance self-purchase: Escrowed (self-trading allowed)')
  await write(A, C, 'markDelivered', [keyM, A.address])
  await write(A, C, 'confirmReceipt', [keyM])
  deal = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'deal', args: [keyM, A.address] })
  ok(deal.state === 3, 'main-instance confirmReceipt: Released')
  const expectedNet = (PRICE * (10000n - FEE_BPS)) / 10000n
  const creditsAfter = await A.publicClient.readContract({ address: C, abi: abis, functionName: 'credits', args: [A.address] })
  ok(creditsAfter - creditsBefore === expectedNet, `main-instance credits delta = ${ai3(expectedNet)} (fee pushed to treasury = self)`)
  await write(A, C, 'withdraw', [])
  const spent = a0 - (await bal(A))
  ok(spent < gasOf({ gasUsed: 2_000_000n, effectiveGasPrice: 10_700_000_000n }), `self-trade total net spend ≈ gas (fee and net both return to self; actual ${ai3(spent)})`)
  await write(A, C, 'setPrice', [keyM, 0n]) // unlist cleanup
}

console.log(`\nAll ${passed} checks passed (real mainnet transactions included; fresh keys per run make it idempotent)`)
