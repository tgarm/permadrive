// File-encryption selftest. Offline, zero-cost, idempotent.
//   node file-crypto-selftest.mjs
//
// Imports the real frontend code (lib/fileCrypto.ts + lib/manifest.ts — the
// i18n/core split makes lib modules Node-importable; the signing callback is
// injected, no registry/config dependency). Signers are HMAC stubs: the
// deterministic stub stands in for local EVM keys (RFC6979 — real EVM
// determinism is verified in scripts/p3/vault-crypto-selftest.mjs); the
// nondeterministic stub stands in for injected wallets. Real browser behavior
// is covered by the build + smoke test + mainnet E2E.

import { createDecipheriv, createHmac } from 'node:crypto'
import {
  addPassphraseChannel,
  addSignatureChannel,
  decryptFileBytes,
  fileSignMessage,
  requireChannel,
  startEncryption,
} from '../../frontend/src/lib/fileCrypto.ts'
import { migrateManifest, validateManifest } from '../../frontend/src/lib/manifest.ts'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16), 16))
const eqBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b))

// Signing stub: HMAC(secret, message) — same secret + message always yields the same signature (deterministic stand-in)
async function hmacSigner(secretHex) {
  const key = await subtle.importKey('raw', fromHex(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return async (message) => new Uint8Array(await subtle.sign('HMAC', key, enc.encode(message)))
}
// Nondeterministic stub: a random signature every call (stand-in for non-reproducible injected wallets)
const randomSigner = async () => crypto.getRandomValues(new Uint8Array(64))
const randomSignerFn = () => () => randomSigner()

const ADDR_A = '0x47ce1b1a2d6bb34fdbaf0a772694f72ba3d0668e'
const ADDR_B = '0x1111111111111111111111111111111111111111'
const PLAIN = enc.encode('PermaDrive batch A secret payload \u{1F512} — 0123456789')

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// ---- 1. encryption session ----
const session = await startEncryption(PLAIN)
ok(!eqBytes(session.cipher, PLAIN), 'encryption: ciphertext ≠ plaintext')
ok(session.encryption.cipherSize === PLAIN.length + 16, 'cipherSize = plaintext + GCM tag (16B)')
ok(/^[0-9a-f]{64}$/.test(session.encryption.cipherSha256), 'cipherSha256 is 64 hex')
ok(/^[0-9a-f]{24}$/.test(session.encryption.iv), 'IV is 12B hex')
ok(session.encryption.wrappedKeys.length === 0, 'starts with no wrap channels')
let rejected = false
try {
  requireChannel(session)
} catch {
  rejected = true
}
ok(rejected, 'requireChannel refuses to publish with no channel')

// ---- 2. signature channel (determinism self-check) ----
const signA = await hmacSigner('aa'.repeat(32))
const deterministic = await addSignatureChannel(session, ADDR_A, signA)
ok(deterministic, 'deterministic signer: self-check passes, signature channel active')
ok(
  session.encryption.wrappedKeys.length === 1 &&
    session.encryption.wrappedKeys[0].mode === 'signature-v1' &&
    session.encryption.wrappedKeys[0].message === fileSignMessage(ADDR_A),
  'wrap channel: mode/message domain separation (file key wrap v1 · address)',
)

// ---- 3. decryption (signature channel) ----
const plain1 = await decryptFileBytes(session.cipher, session.encryption, signA, async () => null)
ok(eqBytes(plain1, PLAIN), 'signature-channel decryption: plaintext round-trips')
let wrongSignerThrew = false
try {
  // another wallet's signature (deterministic but the wrong key) → GCM unwrap fails → no passphrase channel → throws
  await decryptFileBytes(session.cipher, session.encryption, await hmacSigner('bb'.repeat(32)), async () => null)
} catch {
  wrongSignerThrew = true
}
ok(wrongSignerThrew, 'another wallet cannot unwrap (falls back to the passphrase channel with none set → throws)')

// ---- 4. ciphertext integrity (the retrieve-layer criterion) ----
const tampered = new Uint8Array(session.cipher)
tampered[tampered.length - 1] ^= 0xff
ok(
  Buffer.from(await crypto.subtle.digest('SHA-256', tampered)).toString('hex') !== session.encryption.cipherSha256,
  'tampered ciphertext: cipherSha256 mismatch (rejected at the retrieve layer)',
)
let gcmRejected = false
try {
  await decryptFileBytes(tampered, session.encryption, signA, async () => null)
} catch {
  gcmRejected = true
}
ok(gcmRejected, 'tampered ciphertext: GCM authentication refuses to decrypt')

// ---- 5. passphrase channel (both channels coexist) ----
const session2 = await startEncryption(PLAIN)
const det2 = await addSignatureChannel(session2, ADDR_A, signA)
await addPassphraseChannel(session2, 'correct horse battery staple')
ok(det2 && session2.encryption.wrappedKeys.length === 2, 'both channels coexist: signature + passphrase')
const viaPass = await decryptFileBytes(session2.cipher, session2.encryption, null, async () => 'correct horse battery staple')
ok(eqBytes(viaPass, PLAIN), 'no signer (new device): the passphrase channel unlocks independently')
let badPassThrew = false
try {
  await decryptFileBytes(session2.cipher, session2.encryption, null, async () => 'wrong password')
} catch {
  badPassThrew = true
}
ok(badPassThrew, 'wrong passphrase: GCM authentication rejects')

// ---- 6. nondeterministic signer (injected stand-in) ----
const session3 = await startEncryption(PLAIN)
const det3 = await addSignatureChannel(session3, ADDR_A, randomSignerFn())
ok(det3 === false && session3.encryption.wrappedKeys.length === 0, 'nondeterministic signature: self-check fails, no signature channel created')
await addPassphraseChannel(session3, 'fallback pass')
requireChannel(session3)
ok(session3.encryption.wrappedKeys.length === 1, 'requireChannel passes once the passphrase channel is added')
let cancelThrew = false
try {
  await decryptFileBytes(session3.cipher, session3.encryption, null, async () => null)
} catch {
  cancelThrew = true
}
ok(cancelThrew, 'cancelling the passphrase prompt aborts decryption without crashing')

// ---- 7. manifest v2 validation ----
function fakeManifest(version, encryption) {
  return {
    version,
    network: 'mainnet',
    rootCid: 'bafkrcihyrkvgrtwlnqhptftkmy7dwzj3tn37p3xwjmaaowvwyvmg6dta3i',
    file: { name: 'secret.txt', size: PLAIN.length, sha256: 'a'.repeat(64), mimeType: 'text/plain' },
    encryption,
    compression: null,
    uploader: { address: ADDR_A },
    nodes: [{ cid: 'bafkrcihyrkvgrtwlnqhptftkmy7dwzj3tn37p3xwjmaaowvwyvmg6dta3i', blake3: 'b'.repeat(64), bytes: 100 }],
    txs: [{ txHash: '0xc'.repeat(1) + 'c'.repeat(63), blockHash: '0x' + 'd'.repeat(64), height: 100 }],
    submittedAt: '2026-10-29T00:00:00.000Z',
  }
}
const good = fakeManifest(2, JSON.parse(JSON.stringify(session2.encryption)))
ok(validateManifest(good) === null, 'manifest v2 (with an encryption block) validates')
ok(validateManifest(fakeManifest(2, null)) === null, 'manifest v2 (plain, encryption null) validates')
ok(validateManifest(fakeManifest(1, null)) === null, 'manifest v1 (old files) validates')
ok(validateManifest(fakeManifest(1, good.encryption)) !== null, 'v1 + encryption block: rejected')
for (const [label, mutate] of [
  ['bad scheme', (e) => ({ ...e, scheme: 'other' })],
  ['bad IV', (e) => ({ ...e, iv: 'zz' })],
  ['bad cipherSha256', (e) => ({ ...e, cipherSha256: 'abc' })],
  ['bad cipherSize', (e) => ({ ...e, cipherSize: 0 })],
  ['empty wrappedKeys', (e) => ({ ...e, wrappedKeys: [] })],
  ['bad wrap mode', (e) => ({ ...e, wrappedKeys: [{ ...e.wrappedKeys[0], mode: 'x' }] })],
  ['missing wrap fields', (e) => ({ ...e, wrappedKeys: [{ mode: 'signature-v1', iv: 'aa', ct: 'bb' }] })],
]) {
  const bad = fakeManifest(2, mutate(JSON.parse(JSON.stringify(session2.encryption))))
  ok(validateManifest(bad) !== null, `manifest v2 encryption block ${label}: rejected`)
}
ok(validateManifest('not json') !== null, 'non-object: rejected')

// ---- 8. serialization round trip (still valid after JSON.stringify — no Uint8Array may leak into the manifest) ----
const round = JSON.parse(JSON.stringify(good))
ok(validateManifest(round) === null, 'manifest validates after a JSON serialization round trip')

// ---- 9. migrateManifest chain ----
const v1 = fakeManifest(1, null)
const v1up = migrateManifest(JSON.parse(JSON.stringify(v1)))
ok(v1up.version === 2 && v1up.encryption === null, 'migrateManifest: v1 → v2 (encryption stays null)')
const poc = {
  network: 'Autonomys Mainnet',
  rootCid: v1.rootCid,
  file: { name: 'x.bin', size: 1, sha256: 'e'.repeat(64) },
  nodes: v1.nodes,
  txs: v1.txs,
}
const pocUp = migrateManifest(poc)
ok(pocUp.version === 2 && pocUp.network === 'mainnet' && pocUp.nodes.length === 1, 'migrateManifest: PoC v0 → v2')
const v2pass = migrateManifest(JSON.parse(JSON.stringify(good)))
ok(v2pass.version === 2 && v2pass.encryption !== null && v2pass.encryption.scheme === 'pdenc-v1', 'migrateManifest: v2 passes through (encryption block preserved)')

// ---- 10. independent decryption cross-check (no frontend code — guards against shared implementation bugs) ----
const key = session.key
const iv = fromHex(session.encryption.iv)
const ct = Buffer.from(session.cipher)
const tag = ct.subarray(ct.length - 16) // GCM: the trailing 16B is the auth tag
const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv))
decipher.setAuthTag(tag)
const plainX = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
ok(plainX.equals(Buffer.from(PLAIN)), 'independent Node crypto implementation: the same K/IV yields the same plaintext (cross-checked with WebCrypto)')

console.log(`\nAll ${passed} checks passed (offline, zero cost)`)
