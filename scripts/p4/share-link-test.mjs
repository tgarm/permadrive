// Deep-link parsing offline tests — pure Node, zero network. Covers: the real
// CID parser rejecting an invalid/non-canonical m (not a regex), the h
// safe-integer bound, the o address shape, k as 64 hex, whole-link rejection
// on any bad parameter, the buildShareLink round trip, the hash prefix.

import { parseShareHash, buildShareLink, parseCidStrict, SHARE_HASH_PREFIX } from '../../frontend/src/lib/shareLink.ts'

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// A real CID (CIDv1 raw blake3, same shape as PermaDrive packing; lowercase canonical base32)
const CID_OK = 'bafkreig4wikelzw2pttlm6uzgt7hgfulufzdpmbv4wsyl62amkiecux2he'

ok(parseCidStrict(CID_OK).ok === true, 'parseCidStrict accepts a canonical CIDv1')
ok(parseCidStrict('bafkrxxx').ok === false, 'parseCidStrict rejects an incomplete string (multibase/multihash decode fails)')
ok(parseCidStrict('hello-world-12345').ok === false, 'parseCidStrict rejects arbitrary strings (a real parser, not a regex)')
ok(parseCidStrict(CID_OK.toUpperCase()).ok === false, 'parseCidStrict rejects a non-canonical form (uppercase base32)')

// ---- Valid links ----

const h1 = `#/s?m=${CID_OK}&h=5331816&o=0x47cE1B1A2D6bB34FdBaf0a772694f72bA3d0668e&k=${'ab'.repeat(32)}`
const r1 = parseShareHash(h1)
ok(r1.ok === true, 'a valid m/h/o/k link parses')
if (r1.ok) {
  ok(r1.params.manifestCid === CID_OK, 'm keeps its canonical form')
  ok(r1.params.height === 5331816, 'h parses as a safe integer')
  ok(r1.params.owner === '0x47ce1b1a2d6bb34fdbaf0a772694f72ba3d0668e', 'o is lowercased')
  ok(r1.params.key === '0x' + 'ab'.repeat(32), 'k normalizes to a 0x-prefixed 32-byte key')
}

const r2 = parseShareHash(`#/s?m=${CID_OK}`)
ok(r2.ok === true && r2.params.height === null && r2.params.owner === null && r2.params.key === null, 'an m-only link is valid (h/o/k optional)')

// ---- Invalid parameters reject the whole link ----

ok(parseShareHash('#/other?x=1').ok === false, 'a non-#/s prefix is rejected')
ok(parseShareHash('#/s?').ok === false, 'a missing m is rejected')
ok(parseShareHash(`#/s?m=not-a-cid`).ok === false, 'a bad m (not a CID) is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&h=1.5`).ok === false, 'a non-integer h is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&h=${2 ** 53}`).ok === false, 'an h over 2^53 is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&h=-1`).ok === false, 'a negative h is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&o=0x1234`).ok === false, 'a bad o (too short) is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&o=0x${'0'.repeat(40)}`).ok === false, 'the zero address as o is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&k=${'zz'.repeat(32)}`).ok === false, 'a non-hex k is rejected')
ok(parseShareHash(`#/s?m=${CID_OK}&k=${'ab'.repeat(31)}`).ok === false, 'a 31-byte k is rejected')

// ---- Build/parse round trip (hash kept + copy link) ----

const link = buildShareLink({ manifestCid: CID_OK, height: 5331816, owner: '0x47cE1B1A2D6bB34FdBaf0a772694f72bA3d0668e', key: '0x' + 'ab'.repeat(32) }, 'https://permadrive.ai3.land/')
ok(link.startsWith('https://permadrive.ai3.land/#/s?m='), 'buildShareLink produces the production deep link')
const back = parseShareHash(link.slice(link.indexOf('#')))
ok(back.ok === true && back.params.manifestCid === CID_OK && back.params.height === 5331816 && back.params.key === '0x' + 'ab'.repeat(32), 'build -> parse round trip is identical')

const linkNoBase = buildShareLink({ manifestCid: CID_OK, height: null, owner: null, key: null }, 'http://127.0.0.1:5174/')
ok(linkNoBase.startsWith('http://127.0.0.1:5174/#/s?m='), 'an explicit base overrides (local loopback testing)')
ok(SHARE_HASH_PREFIX === '#/s?', 'SHARE_HASH_PREFIX contract')

console.log(`\n${passed} assertions passed`)
process.exit(0)
