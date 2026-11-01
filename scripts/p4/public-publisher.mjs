// PublicPublisher mainnet selftest (acceptance item 1). Real transactions;
// re-runs use a fresh CID (the script embeds a timestamp, idempotent by design).
//   node public-publisher.mjs
//
// Flow (main instance, trust domain welded to the main DirectSales):
//   dust listing (createRevision price=DUST_PRICE=1e13) -> publish{value:
//   DUST_PRICE} completes purchase + the Published event atomically -> all
//   event fields read back -> 90% of the dust returns (seller net cost = gas +
//   platform fee 1e12; treasury differs from the signer so deltas are exact)
//   -> order stored with buyer=publisher -> both contract balances stay 0 (no
//   standing funds). The Published event IS the public log; this selftest uses
//   a synthetic selftest- CID, and phase 1 only queries events by exact
//   fileKey topic (no global directory), so it never surfaces anywhere.
// Note: publish passes an explicit gas to bypass evm_estimateGas - the domain
// estimator reserves "value + block gas limit x price" for value>0 calls and
// false-reports OutOfFund once the balance drops below ~0.54 AI3 (real
// execution reserves only actual gas x price).
// Re-run guard: the same CID -> DuplicateEntry / ListingMismatch, expected;
// re-running the full flow uses a fresh CID automatically.
import { readFileSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'
import { keccak256, toHex, decodeEventLog, formatEther } from 'viem'

const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const SALES = deployments['auto-evm-mainnet-direct-sales']
const PUB = deployments['auto-evm-mainnet-public-publisher']
if (!SALES || !PUB) throw new Error('deployments.json lacks the direct-sales / public-publisher entries')
const salesAbi = JSON.parse(readFileSync(new URL('../../contracts/out/DirectSales.json', import.meta.url).pathname, 'utf8')).abi
const pubAbi = JSON.parse(readFileSync(new URL('../../contracts/out/PublicPublisher.json', import.meta.url).pathname, 'utf8')).abi

const A = clients(0) // seller (the publisher must be the listing seller, D10)
console.log('A (seller):', A.address, '·', ai3(await A.publicClient.getBalance({ address: A.address })))
console.log('sales:', SALES.address, '· publisher:', PUB.address)

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const bal = (addr) => A.publicClient.getBalance({ address: addr })
const gasOf = (receipt) => receipt.gasUsed * receipt.effectiveGasPrice
const DUST = 10n ** 13n // DUST_PRICE (mainnet readback asserted below)
const FEE = DUST / 10n // platformBps 1000 -> the fee is exactly 1e12 (straight to treasury)

async function write(c, contract, abi, fn, args, value = 0n, gas = 0n) {
  // An explicit gas bypasses evm_estimateGas: the Auto-EVM estimator reserves
  // "value + block gas limit x price" for value>0 calls and false-reports
  // OutOfFund once the balance is below ~0.54 AI3 (real execution reserves
  // only actual gas x price).
  const hash = await c.walletClient.writeContract({ address: contract, abi, functionName: fn, args, chain: autoEvm, ...(value ? { value } : {}), ...(gas ? { gas } : {}) })
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(`${fn} tx ${receipt.status}`)
  return receipt
}

const decodeLogs = (receipt, address, abi) =>
  receipt.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics }))

// ---- constants and trust domain readback ----
const treasury = deployments['auto-evm-mainnet-direct-sales'].treasury
const treasuryBefore = await bal(treasury)
const pub = A.publicClient
ok((await pub.readContract({ address: PUB.address, abi: pubAbi, functionName: 'sales' })).toLowerCase() === SALES.address.toLowerCase(), 'publisher.sales() == the main DirectSales (trust domain welded)')
ok((await pub.readContract({ address: PUB.address, abi: pubAbi, functionName: 'DUST_PRICE' })) === DUST, 'DUST_PRICE == 1e13 shannon (10x domain ED)')
ok((await pub.readContract({ address: PUB.address, abi: pubAbi, functionName: 'MAX_CID_LENGTH' })) === 128n, 'MAX_CID_LENGTH == 128')

// ---- dust listing ----
// fileKey derivation matches sales.ts: keccak256(UTF-8 bytes of manifestCid)
const manifestCid = `selftest-pubpub-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const fileKey = keccak256(toHex(manifestCid, 'utf8'))
const listingId = await pub.readContract({ address: SALES.address, abi: salesAbi, functionName: 'listingIdOf', args: [A.address, fileKey] })
const termsHash = keccak256(toHex('permadrive public-publisher selftest terms'))
const listRx = await write(A, SALES.address, salesAbi, 'createRevision',
  [fileKey, DUST, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0, 0, termsHash, 0, '0x'])
const rev1 = await pub.readContract({ address: SALES.address, abi: salesAbi, functionName: 'revisionOf', args: [listingId, 1] })
ok(rev1[0] === DUST && rev1[5].toLowerCase() === A.address.toLowerCase() && rev1[9] === termsHash, `dust listing readback (revision 1 · price ${DUST} · gas ${Number(listRx.gasUsed)})`)

// ---- publish{value: DUST_PRICE} ----
const aBefore = await bal(A.address)
const k = keccak256(toHex(`pubpub-selftest-K-${manifestCid}`))
const plainSha = keccak256(toHex(`pubpub-selftest-plain-${manifestCid}`))
const plainSize = 2048n
const heightHint = 5334000n
const pubRx = await write(A, PUB.address, pubAbi, 'publish',
  [A.address, listingId, 1n, manifestCid, k, plainSha, plainSize, heightHint], DUST, 600_000n)
const aAfter = await bal(A.address)

// Dust refund: net cost = gas + platform fee (90% of the dust returns)
ok(aBefore - aAfter === gasOf(pubRx) + FEE, `publish net cost = gas + platform fee ${FEE} (90% dust returned, gas ${formatEther(gasOf(pubRx))} AI3)`)

// Published event fields all read back
const evts = decodeLogs(pubRx, PUB.address, pubAbi).filter((e) => e.eventName === 'Published')
ok(evts.length === 1, 'exactly one Published event')
const ev = evts[0].args
ok(ev.fileKey === fileKey && ev.seller.toLowerCase() === A.address.toLowerCase() && ev.manifestCid === manifestCid, 'event: fileKey/seller/manifestCid all correct')
ok(ev.key === k && ev.plainSha256 === plainSha && ev.plainSize === plainSize && ev.manifestHeightHint === heightHint, 'event: key/plainSha256/plainSize/heightHint all correct')

// The same-transaction purchase stores an order: buyer = publisher, dust price
const purchased = decodeLogs(pubRx, SALES.address, salesAbi).filter((e) => e.eventName === 'Purchased')
ok(purchased.length === 1, 'exactly one DirectSales Purchased event (atomic)')
const orderId = purchased[0].args.orderId
const order = await pub.readContract({ address: SALES.address, abi: salesAbi, functionName: 'orderOf', args: [orderId] })
ok(order[6].toLowerCase() === PUB.address.toLowerCase() && order[1] === DUST && order[10] === fileKey,
  `order stored: buyer=publisher · price DUST_PRICE · fileKey matches (orderId ${orderId})`)

// No standing funds: both contract balances stay 0; treasury receives exactly one fee
ok((await bal(PUB.address)) === 0n && (await bal(SALES.address)) === 0n, 'publisher / sales contract balances stay 0')
ok((await bal(treasury)) - treasuryBefore === FEE, `treasury delta = the platform fee (exact ${FEE})`)

console.log(`\n${passed} assertions passed`)
