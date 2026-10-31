// Offline test for the library-level guards fixed in the third design review:
// the four legacy write entries (setListingPrice / purchase / markDelivered /
// deliverKey) must reject UNCONDITIONALLY in both configurations (v2
// unconfigured / v2 configured), without ever touching the wallet; the v2
// write entries reject with the activation error while v2 is unconfigured and
// reach the wallet once configured; the legacy disposition entries (refund /
// confirm / withdraw) are unaffected by the freeze; assertLegacyPayee refuses
// confirmation for an unknown seller / empty manifestCid. (The listing=null
// branch needs an on-chain read — browser smoke territory.) Zero network, zero
// cost.
//   node paywall-guard-test.mjs

import assert from 'node:assert'
import 'fake-indexeddb/auto'

// localStorage shim — config.ts depends on it; must be in place BEFORE
// importing paywall.ts
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}

const i18nM = await import('../../frontend/src/i18n/core.ts')
const enDict = (await import('../../frontend/src/i18n/en.json', { with: { type: 'json' } })).default
i18nM.registerDictionaries({ en: enDict })
const { t } = i18nM

const paywallM = await import('../../frontend/src/lib/paywall.ts')
const configM = await import('../../frontend/src/lib/config.ts')
const { setListingPrice, purchase, markDelivered, deliverKey, deliverKeyV2, purchaseV2, setListingPriceV2, confirmReceipt, assertLegacyPayee } = paywallM
const { saveConfig, DEFAULT_CONFIG } = configM

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// sentinel signer: any property access is recorded and throws — if a guard
// lets a call through, the wallet is necessarily touched
const touched = []
const sentinel = new Proxy({}, { get(_, p) { touched.push(String(p)); throw new Error('wallet accessed: ' + String(p)) } })
const signer = sentinel
const BUYER = '0xe8640b06a8c1c916c4d0b6a9a9c9cf6bbdbe51bb'

const rejectsMsg = async (fn, msg, label) => {
  try {
    await fn()
  } catch (e) {
    assert.equal(e?.message, msg, label)
    ok(true, label)
    return
  }
  throw new Error(`expected rejection: ${label}`)
}

// catches both sync throws and rejected promises (writeOps can throw before a
// promise is even returned)
const rejectsAny = async (fn, match, label) => {
  try {
    await Promise.resolve().then(fn)
  } catch (e) {
    assert.match(String(e?.message ?? e), match, label)
    ok(true, label)
    return
  }
  throw new Error(`expected rejection: ${label}`)
}

const frozenMsg = () => t('errors.paywallLegacyFrozen')
const v2RequiredMsg = () => t('errors.paywallV2Required')
const payeeUnknownMsg = () => t('errors.paywallPayeeUnknown')

const legacyWriteFour = () => [
  () => setListingPrice(signer, 'bafkr-test', 10n ** 17n),
  () => purchase(signer, 'bafkr-test', 10n ** 17n),
  () => markDelivered(signer, 'bafkr-test', BUYER),
  () => deliverKey(signer, 'bafkr-test', null, BUYER, async () => null),
]

// ---- 1. v2 unconfigured: the four legacy writes reject unconditionally ----
{
  for (const [i, fn] of legacyWriteFour().entries()) {
    await rejectsMsg(fn, frozenMsg(), `1.${i + 1} legacy write rejected (v2 unconfigured)`)
  }
  ok(touched.length === 0, '1 sentinel wallet never touched')
}

// ---- 2. v2 unconfigured: v2 write entries reject with the activation error ----
{
  await rejectsMsg(() => purchaseV2(signer, 'bafkr-test', BUYER, 10n ** 17n), v2RequiredMsg(), '2.1 purchaseV2 activation guard')
  await rejectsMsg(() => setListingPriceV2(signer, 'bafkr-test', 10n ** 17n), v2RequiredMsg(), '2.2 setListingPriceV2 activation guard')
  await rejectsMsg(() => deliverKeyV2(signer, 'bafkr-test', null, BUYER, 1n, async () => null), v2RequiredMsg(), '2.3 deliverKeyV2 activation guard (before any message/tx)')
  ok(touched.length === 0, '2 sentinel wallet never touched')
}

// ---- 3. legacy disposition entries are NOT frozen (refund/confirm/withdraw stay) ----
{
  // confirmReceipt passes the guard and reaches the wallet (the sentinel
  // throwing "wallet accessed" = not intercepted by the freeze)
  await rejectsAny(() => confirmReceipt(signer, 'bafkr-test'), /wallet accessed/, '3.1 legacy confirmReceipt not intercepted by the freeze')
  ok(touched.length > 0, '3 sentinel wallet touched (disposition entries stay open)')
  touched.length = 0
}

// ---- 4. F01 regression core: v2 configured, the four legacy writes STILL reject ----
{
  const V2 = '0x79a22e5dc2e0613d8e9b491a1a51038b9197b185'
  saveConfig({ ...DEFAULT_CONFIG, paywallV2Address: V2 })
  ok(paywallM.paywallV2Active() === true, '4 precondition: v2 configured with a valid address')
  for (const [i, fn] of legacyWriteFour().entries()) {
    await rejectsMsg(fn, frozenMsg(), `4.${i + 1} legacy write rejected (v2 configured — the old implementation let this through)`)
  }
  ok(touched.length === 0, '4 sentinel wallet never touched (v1 stays frozen with v2 present)')
}

// ---- 5. v2 configured: v2 write entries pass the activation guard and reach the wallet ----
{
  await rejectsAny(() => purchaseV2(signer, 'bafkr-test', BUYER, 10n ** 17n), /wallet accessed/, '5.1 purchaseV2 passes the activation guard')
  ok(touched.length > 0, '5 activation guard opens once v2 is configured')
  touched.length = 0
}

// ---- 6. assertLegacyPayee: unknown seller / empty manifestCid refuse confirmation ----
{
  await rejectsMsg(() => assertLegacyPayee(null, BUYER), payeeUnknownMsg(), '6.1 empty manifestCid → refuse')
  await rejectsMsg(() => assertLegacyPayee('bafkr-test', ''), payeeUnknownMsg(), '6.2 empty seller → refuse')
  await rejectsMsg(() => assertLegacyPayee('', ''), payeeUnknownMsg(), '6.3 both empty → refuse')
  // the listing=null / seller-mismatch branches need an on-chain read —
  // covered by browser smoke
}

// ---- 7. error copy matches the new semantics (en base dictionary spot check) ----
{
  ok(/permanently rejected/.test(frozenMsg()), '7.1 frozen copy states a permanent rejection')
  ok(/Use Refund/.test(payeeUnknownMsg()), '7.2 payeeUnknown copy points to refund')
}

console.log(`\npaywall-guard-test: ${passed} items passed`)
