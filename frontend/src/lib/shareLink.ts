// Share deep links (D11 integrity rules). The app has no router (App.tsx is
// plain state), so deep links use the hash form `#/s?...` (zero-config on
// Vercel static hosting); the hash is parsed once on app mount. The hash is
// kept, never cleared — the landing view is read-only and idempotent (a
// refresh re-parses; transactions only fire on explicit clicks), no
// hashchange listener in the MVP: pasting a new link applies after refresh.
//
// Parameters are never trusted — validation happens at parse time:
//  - m: a real CID parser (multibase+multihash decode, not just a regex) plus
//       canonical round-trip
//  - h: safe integer (<= 2^53-1); the <= chain-height check happens after
//       parsing (needs the api — only the static bound lives here)
//  - o: EVM address shape (non-zero)
//  - k: 64 hex chars (the 32-byte file key K — public files are not secrets,
//       the URL leaks nothing; paid/private files never carry k; correctness
//       is self-evident from the AES-GCM authentication tag)

import { cidToString, stringToCid } from '@autonomys/auto-dag-data'

export const SHARE_HASH_PREFIX = '#/s?'

/** Deep-link site base (the generator's default; local development derives a
 *  same-origin link from location for loopback testing) */
export const PRODUCTION_BASE = 'https://permadrive.ai3.land/'

export interface ShareLinkParams {
  manifestCid: string
  height: number | null // h (optional; not needed when the Registry hits)
  owner: string | null // o (for-sale links always carry it)
  /** 0x-prefixed 32-byte hex (public files only; null = a share without a key) */
  key: string | null
}

export interface ParsedShareLink {
  ok: true
  params: ShareLinkParams
}

export interface ParsedShareLinkError {
  ok: false
  /** an i18n key (share.badParam.*); bad carries the offending parameter for the UI */
  reason: string
  bad?: string
}

/** Real CID parsing (multibase+multihash decode plus a canonical round trip) —
 *  invalid input is rejected explicitly */
export function parseCidStrict(cid: string): { ok: true; canonical: string } | { ok: false; reason: string } {
  try {
    const parsed = stringToCid(cid)
    const canonical = cidToString(parsed)
    if (canonical !== cid) return { ok: false, reason: 'share.badParam.cidNotCanonical' }
    return { ok: true, canonical }
  } catch (e) {
    return { ok: false, reason: 'share.badParam.cidInvalid' }
  }
}

const isSafeHeight = (v: number): boolean => Number.isSafeInteger(v) && v >= 0 && v <= 2 ** 53 - 1

/** Parse the `#/s?...` query. Any invalid parameter rejects the whole link
 *  (ok:false with a stable reason key). */
export function parseShareHash(hash: string): ParsedShareLink | ParsedShareLinkError {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return { ok: false, reason: 'share.badParam.notShareLink' }
  const query = hash.slice(SHARE_HASH_PREFIX.length)
  const usp = new URLSearchParams(query)
  const m = usp.get('m')?.trim() ?? ''
  if (!m) return { ok: false, reason: 'share.badParam.missingManifest' }
  const cid = parseCidStrict(m)
  if (!cid.ok) return { ok: false, reason: cid.reason, bad: m }

  let height: number | null = null
  const h = usp.get('h')
  if (h != null && h !== '') {
    const n = Number(h)
    if (!isSafeHeight(n)) return { ok: false, reason: 'share.badParam.badHeight', bad: h }
    height = n
  }

  let owner: string | null = null
  const o = usp.get('o')?.trim() ?? ''
  if (o) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(o) || /^0x0{40}$/.test(o)) return { ok: false, reason: 'share.badParam.badOwner', bad: o }
    owner = o.toLowerCase()
  }

  let key: string | null = null
  const k = usp.get('k')?.trim() ?? ''
  if (k) {
    if (!/^[0-9a-fA-F]{64}$/.test(k)) return { ok: false, reason: 'share.badParam.badKey', bad: k.slice(0, 12) + '…' }
    key = '0x' + k.toLowerCase()
  }

  return { ok: true, params: { manifestCid: cid.canonical, height, owner, key } }
}

/** Build a deep link. base defaults to the current origin (self-consistent
 *  loopback in dev and production); falls back to the production site when
 *  location is unavailable. */
export function buildShareLink(params: ShareLinkParams, base?: string): string {
  let root = base ?? ''
  if (!root) {
    try {
      root = `${location.origin}${location.pathname}`
    } catch {
      root = PRODUCTION_BASE
    }
  }
  if (!root.endsWith('/')) root += '/'
  const usp = new URLSearchParams()
  usp.set('m', params.manifestCid)
  if (params.height != null) usp.set('h', String(params.height))
  if (params.owner) usp.set('o', params.owner)
  if (params.key) usp.set('k', params.key.replace(/^0x/, ''))
  return `${root}#/s?${usp.toString()}`
}
