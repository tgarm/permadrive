// Offline tests for local file-ownership resolution (2026-11-01): the verdict order
// (registry record > local stamp > Substrate-uploader fallback > unclaimed),
// case-insensitive address comparison, and the meta-stamp roundtrip. Pure
// dependency-free — fake IndexedDB, no network, no cost.
//   node file-ownership-test.mjs

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

const { stampFileOwner, getStampedOwner, resolveOwnership } = await import('../../frontend/src/lib/fileOwnership.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const manifestFor = (rootCid, uploader = null) => ({ rootCid, uploader: uploader ? { address: uploader } : null })
const input = (overrides = {}) => ({
  myAddress: ME,
  mySubstrateAddress: null,
  records: [],
  ...overrides,
})

// ---- 1. stamp roundtrip: normalized to lowercase ----
{
  await stampFileOwner('root-x', '0xAAAA')
  ok((await getStampedOwner('root-x')) === '0xaaaa', '1 stamp roundtrip is lowercase-normalized')
  ok((await getStampedOwner('root-missing')) === null, '1 missing stamp reads null')
}

// ---- 2. registry record wins: record mine → mine even with a foreign stamp ----
{
  const v = await resolveOwnership(manifestFor('root-a'), input({ records: [{ rootCid: 'root-a', evmAddress: OTHER }, { rootCid: 'root-a', evmAddress: ME.toUpperCase() }] }))
  ok(v === 'mine', '2 record with my address (case-insensitive) → mine')
}
{
  await stampFileOwner('root-b', ME)
  const v = await resolveOwnership(manifestFor('root-b'), input({ records: [{ rootCid: 'root-b', evmAddress: OTHER }] }))
  ok(v === 'mine', '2 foreign record + my stamp → mine (stamp beats other records)')
}
{
  await stampFileOwner('root-c', OTHER)
  const v = await resolveOwnership(manifestFor('root-c'), input({ records: [{ rootCid: 'root-c', evmAddress: OTHER }] }))
  ok(v === 'other', '2 foreign record + foreign stamp → other')
}

// ---- 3. stamp-only resolution ----
{
  await stampFileOwner('root-d', ME)
  ok((await resolveOwnership(manifestFor('root-d'), input())) === 'mine', '3 my stamp, no records → mine')
  ok((await resolveOwnership(manifestFor('root-c'), input())) === 'other', '3 foreign stamp, no records → other')
}

// ---- 4. Substrate uploader fallback (legacy unstamped uploads) ----
{
  const v = await resolveOwnership(manifestFor('root-e', 'sub-me'), input({ mySubstrateAddress: 'sub-me' }))
  ok(v === 'mine', '4 uploader matches connected Substrate signer → mine')
}
{
  const v = await resolveOwnership(manifestFor('root-f', 'sub-other'), input({ mySubstrateAddress: 'sub-me' }))
  ok(v === 'unknown', '4 uploader mismatch → unknown (unclaimed group)')
}
{
  await stampFileOwner('root-g', OTHER)
  const v = await resolveOwnership(manifestFor('root-g', 'sub-me'), input({ mySubstrateAddress: 'sub-me' }))
  ok(v === 'other', '4 foreign stamp beats matching uploader (stamp is stronger)')
}
{
  const v = await resolveOwnership(manifestFor('root-h', 'sub-me'), input({ mySubstrateAddress: 'sub-me', records: [{ rootCid: 'root-h', evmAddress: OTHER }] }))
  ok(v === 'mine', '4 matching uploader beats a foreign record (content authorship is mine; the other registration does not erase it)')
}

// ---- 5. nothing known → unknown (manual claim) ----
{
  const v = await resolveOwnership(manifestFor('root-i'), input())
  ok(v === 'unknown', '5 no record/stamp/uploader match → unknown')
}

// ---- 6. uploader null-safe ----
{
  const v = await resolveOwnership(manifestFor('root-j'), input({ mySubstrateAddress: 'sub-me' }))
  ok(v === 'unknown', '6 manifest without uploader does not crash')
}

console.log(`\n${passed} assertions passed`)
if (process.exitCode) console.error('FAILED')
