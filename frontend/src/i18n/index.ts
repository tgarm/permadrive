// Minimal i18n (same JSON key format and {0} placeholder syntax as the
// ai3-xdm-bridge i18n module — no third-party library). Locale resolution:
// localStorage saved value → browser language → 'en' fallback. 'en' is the
// authoritative dictionary (the source of keys); missing keys fall back to en.
// The en/zh dictionaries are shared verbatim across PermaDrive frontends.

import { useSyncExternalStore } from 'react'
import en from './en.json'
import zh from './zh.json'

export const messages: Record<Locale, Record<string, unknown>> = { en, zh }
export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

const LOCALE_KEY = 'locale'

const listeners = new Set<() => void>()
let locale = getDefaultLocale()

function getDefaultLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved && isLocale(saved)) return saved
  } catch {
    // localStorage unavailable (private mode etc.) — skip the saved value
  }
  // Browser language: primary tag first, then the full preference list ('zh-CN' → 'zh')
  const candidates = [navigator.language, ...navigator.languages]
  for (const tag of candidates) {
    const base = tag?.split('-')[0]
    if (base && isLocale(base)) return base
  }
  return 'en'
}

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v)
}

export function getLocale(): Locale {
  return locale
}

export function setLocale(next: Locale): void {
  locale = next
  try {
    localStorage.setItem(LOCALE_KEY, next)
  } catch {
    // a failed write must not break switching for the current session
  }
  syncDocument()
  listeners.forEach((fn) => fn())
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Mirror the locale into the document: <html lang> and the tab title
export function syncDocument(): void {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  document.title = t('app.title')
}

function lookup(key: string): string | undefined {
  const path = key.split('.')
  const walk = (root: Record<string, unknown>): unknown => {
    let node: unknown = root
    for (const part of path) {
      if (node == null || typeof node !== 'object') return undefined
      node = (node as Record<string, unknown>)[part]
    }
    return node
  }
  // current locale first, then fall back to en (the authoritative key source)
  const node = walk(messages[locale]) ?? walk(messages.en)
  return typeof node === 'string' ? node : undefined
}

// t('files.recoverDone', [a, b, c]) → replaces {0} {1} {2}…
export function t(key: string, ...args: unknown[]): string {
  const template = lookup(key)
  if (template === undefined) return key
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  return template.replace(/\{(\d+)\}/g, (m, i) => (list[i] !== undefined ? String(list[i]) : m))
}

// Count plurals (en needs them; zh shares the same value)
export function versionCount(n: number): string {
  return t(n === 1 ? 'common.oneVersion' : 'common.nVersions', [n])
}

export function nodeCount(n: number): string {
  return t(n === 1 ? 'common.oneNode' : 'common.nNodes', [n])
}

export function useI18n() {
  useSyncExternalStore(subscribe, getLocale)
  return { t, locale, setLocale, locales: LOCALES }
}

// Sync document language and title once at module load
syncDocument()
