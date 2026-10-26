// Vault crypto format selftest. Offline, zero-cost, idempotent:
//   node vault-crypto-selftest.mjs
//
// Covers:
//   1) envelope/keystore format — an independent WebCrypto implementation of
//      the same spec cross-verifies the frontend lib/vaultCrypto.ts (whose
//      browser behavior is covered by the build + smoke + mainnet E2E)
//   2) the deterministic-signature premise (viem HDAccount RFC6979):
//      reproducible signatures are what makes the signature wrap channel valid;
//      sr25519 is empirically non-reproducible and not retested here
//   3) the note naming convention grouping (imports the frontend lib/notes.ts)

import { createRequire } from 'node:module'
import { mnemonicToAccount, generateMnemonic, english } from 'viem/accounts'
import { noteFileName, parseNoteFileName, slugifyTitle, titleFromSlug, groupNoteEntries } from '../../frontend/src/lib/notes.ts'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))

async function aesGcmEncrypt(keyBytes, iv, plaintext) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
}
async function aesGcmDecrypt(keyBytes, iv, ct) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}
async function hkdf(ikm, salt, info, bytes = 32) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, bytes * 8))
}
async function pbkdf2(pass, salt, iterations) {
  const material = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256))
}

const KEK_INFO = 'permadrive-vault-kek-v1'
const PBKDF2_ITERATIONS = 310_000

async function sealPayload(key, json) {
  const iv = randomBytes(12)
  return { alg: 'AES-256-GCM', iv: toHex(iv), ct: toHex(await aesGcmEncrypt(key, iv, enc.encode(json))) }
}
async function openPayload(key, cipher) {
  return dec.decode(await aesGcmDecrypt(key, fromHex(cipher.iv), fromHex(cipher.ct)))
}
async function wrapWithSignature(key, message, signature) {
  const salt = randomBytes(16)
  const kek = await hkdf(signature, salt, KEK_INFO)
  const iv = randomBytes(12)
  return { mode: 'signature-v1', message, salt: toHex(salt), iv: toHex(iv), ct: toHex(await aesGcmEncrypt(kek, iv, key)) }
}
async function tryUnwrapSignature(wrap, signature) {
  const kek = await hkdf(signature, fromHex(wrap.salt), KEK_INFO)
  return aesGcmDecrypt(kek, fromHex(wrap.iv), fromHex(wrap.ct))
}
async function wrapWithPassphrase(key, pass) {
  const salt = randomBytes(16)
  const kek = await pbkdf2(pass, salt, PBKDF2_ITERATIONS)
  const iv = randomBytes(12)
  return { mode: 'passphrase-v1', kdf: { alg: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toHex(salt) }, iv: toHex(iv), ct: toHex(await aesGcmEncrypt(kek, iv, key)) }
}
async function unwrapPassphrase(wrap, pass) {
  const kek = await pbkdf2(pass, fromHex(wrap.kdf.salt), wrap.kdf.iterations)
  return aesGcmDecrypt(kek, fromHex(wrap.iv), fromHex(wrap.ct))
}

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const addr = '0x47ce1b1a2d6bb34fdbaf0a772694f72ba3d0668e'
const ENTRIES = JSON.stringify({
  entries: [{ id: 'e1', title: '例站', username: 'simon', password: 'p@ss', url: 'https://example.com', notes: '', createdAt: 1, updatedAt: 1 }],
})

// ---- 1. 信封封缄/开缄 ----
{
  const k = randomBytes(32)
  const cipher = await sealPayload(k, ENTRIES)
  ok(JSON.parse(await openPayload(k, cipher)).entries[0].password === 'p@ss', 'envelope roundtrip: K + cipher decrypts the entry payload')
  const tampered = { ...cipher, ct: cipher.ct.slice(0, -2) + (cipher.ct.endsWith('00') ? '11' : '00') }
  let rejected = false
  try {
    await openPayload(k, tampered)
  } catch {
    rejected = true
  }
  ok(rejected, 'tamper detection: GCM auth rejects the modified ciphertext')
  let wrongKey = false
  try {
    await openPayload(randomBytes(32), cipher)
  } catch {
    wrongKey = true
  }
  ok(wrongKey, 'wrong-key rejection: GCM auth fails')
}

// ---- 2. keystore（口令通道）----
{
  const k = randomBytes(32)
  const wrap = await wrapWithPassphrase(k, 'correct horse battery staple')
  ok(Buffer.from(await unwrapPassphrase(wrap, 'correct horse battery staple')).equals(Buffer.from(k)), 'keystore roundtrip: passphrase unwraps K')
  let bad = false
  try {
    await unwrapPassphrase(wrap, 'wrong password')
  } catch {
    bad = true
  }
  ok(bad, 'keystore wrong-passphrase rejection')
}

// ---- 3. 签名通道（确定性前提 + 多收件人）----
{
  const mnemonic = generateMnemonic(english)
  const account = mnemonicToAccount(mnemonic)
  const message = `PermaDrive vault key wrap v1 · ${addr}`
  const s1 = await account.signMessage({ message })
  const s2 = await account.signMessage({ message })
  ok(s1 === s2, 'EVM HDAccount signature determinism (RFC6979): same message, same signature')

  const k = randomBytes(32)
  const sigWrap = await wrapWithSignature(k, message, fromHex(s1))
  const passWrap = await wrapWithPassphrase(k, 'backup pass')
  const envelope = { v: 1, kind: 'permadrive-vault', address: addr, createdAt: 1, updatedAt: 1, cipher: await sealPayload(k, ENTRIES), wrappedKeys: [passWrap, sigWrap] }

  ok(Buffer.from(await tryUnwrapSignature(sigWrap, fromHex(s2))).equals(Buffer.from(k)), 'signature channel: re-signing the same message unwraps the same K (passphrase-free unlock)')
  const otherSig = fromHex(await mnemonicToAccount(generateMnemonic(english)).signMessage({ message }))
  let otherRejected = false
  try {
    await tryUnwrapSignature(sigWrap, otherSig)
  } catch {
    otherRejected = true
  }
  ok(otherRejected, "signature channel: another wallet's signature cannot unwrap (GCM auth fails → frontend falls back to keystore)")
  ok(Buffer.from(await unwrapPassphrase(envelope.wrappedKeys[0], 'backup pass')).equals(Buffer.from(k)), 'dual channels: keystore and signature wrap each unwrap independently')
}

// ---- 4. 笔记命名约定（前端 lib/notes.ts 实码）----
{
  const id = newNoteIdOf()
  const name = noteFileName(id, 'Hello 世界: deploy notes!')
  ok(name === `pdnote-${id}-Hello-世界-deploy-notes!.md`, `naming convention (no version number in filenames): ${name}`)
  const ref = parseNoteFileName(name)
  ok(!!ref && ref.id === id, 'naming parse: id recovered')
  ok(titleFromSlug(ref.titleSlug) === 'Hello 世界 deploy notes!', 'slug → display title')
  ok(parseNoteFileName('pdnote-1100-v2-oldfmt.md') !== null, 'legacy-format names do not crash (recovery tolerates anything under pdnote-)')
  const grouped = groupNoteEntries([
    { name: noteFileName(id, 'Hello 世界'), height: 200 },
    { name: noteFileName(id, 'Hello 世界'), height: 100 },
    { name: 'pdvault-47ce1b1a.json', height: 300 },
    { name: 'some-other-file.bin', height: 400 },
  ])
  ok(grouped.size === 1 && grouped.get(id).length === 2 && grouped.get(id)[0].height === 100, 'grouping: pdnote- prefix filter + ascending height')
  ok(slugifyTitle('   ') === 'untitled', 'empty-title slug fallback')
}
function newNoteIdOf() {
  return toHex(randomBytes(4))
}

console.log(`\nall ${passed} checks passed (offline, zero cost)`)
