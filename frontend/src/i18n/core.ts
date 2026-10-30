// i18n core (pure logic: no browser APIs, no JSON/React dependencies). Code in
// src/lib/ imports t from this file — i18n/index.ts binds react/document/
// localStorage, which only exists in the browser; keeping lib modules free of
// it lets the Node-side selftests (scripts/p3, scripts/p4) import them
// directly. Explicit .ts extensions are required for Node's type-stripping
// resolver. English is the authoritative dictionary; missing keys fall back
// to it.

export type Locale = 'en' | 'zh'
export const LOCALES = ['en', 'zh'] as const

type Dict = Record<string, unknown>

const dictionaries: Partial<Record<Locale, Dict>> = {}

let locale: Locale = 'en'
const listeners = new Set<() => void>()

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v)
}

/** The browser binding (index.ts) injects the dictionaries; without them t() returns the key verbatim */
export function registerDictionaries(dicts: Record<Locale, Dict>): void {
  for (const l of LOCALES) dictionaries[l] = dicts[l]
}

export function getLocale(): Locale {
  return locale
}

/** Switch the locale and notify listeners (persistence and <html> sync belong to the browser binding) */
export function setLocale(next: Locale): void {
  locale = next
  listeners.forEach((fn) => fn())
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function lookup(key: string): string | undefined {
  const path = key.split('.')
  const walk = (root: Dict | undefined): unknown => {
    let node: unknown = root
    for (const part of path) {
      if (node == null || typeof node !== 'object') return undefined
      node = (node as Dict)[part]
    }
    return node
  }
  // current locale first, then fall back to en (the authoritative key set)
  const node = walk(dictionaries[locale]) ?? walk(dictionaries.en)
  return typeof node === 'string' ? node : undefined
}

// t('files.recoverDone', [a, b, c]) → replaces {0} {1} {2}…
export function t(key: string, ...args: unknown[]): string {
  const template = lookup(key)
  if (template === undefined) return key
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  return template.replace(/\{(\d+)\}/g, (m, i) => (list[i] !== undefined ? String(list[i]) : m))
}

// Count plurals (English needs them; zh shares the same values)
export function versionCount(n: number): string {
  return t(n === 1 ? 'common.oneVersion' : 'common.nVersions', [n])
}

export function nodeCount(n: number): string {
  return t(n === 1 ? 'common.oneNode' : 'common.nNodes', [n])
}
