// Lightweight i18n browser binding (same format and rules as the xdm-bridge
// i18n: JSON keys + {0} placeholders, no third-party library). Locale
// resolution: localStorage saved value → browser language → 'en' fallback;
// <html lang> and the tab title follow the locale. The pure state machine and
// t() live in ./core — src/lib/ imports core so Node selftests can import lib
// modules directly. The en/zh dictionaries are byte-identical across trees.

import { useSyncExternalStore } from 'react'
import en from './en.json'
import zh from './zh.json'
import {
  getLocale,
  isLocale,
  nodeCount,
  registerDictionaries,
  setLocale as setCoreLocale,
  subscribe,
  t,
  versionCount,
  LOCALES,
  type Locale,
} from './core.ts'

registerDictionaries({ en, zh })

export { t, getLocale, subscribe, isLocale, versionCount, nodeCount, LOCALES, type Locale }
export const messages: Record<Locale, Record<string, unknown>> = { en, zh }

const LOCALE_KEY = 'locale'

// Browser language: primary language first, then the full preference list ('zh-CN' → 'zh')
function getDefaultLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved && isLocale(saved)) return saved
  } catch {
    // localStorage unavailable (private mode etc.) — skip the saved value
  }
  const candidates = [navigator.language, ...navigator.languages]
  for (const tag of candidates) {
    const base = tag?.split('-')[0]
    if (base && isLocale(base)) return base
  }
  return 'en'
}

// Sync the document: <html lang> and the tab title (title follows the dictionary)
export function syncDocument(): void {
  document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en'
  document.title = t('app.title')
}

export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, next)
  } catch {
    // failing to persist must not affect the current session
  }
  setCoreLocale(next)
  syncDocument()
}

export function useI18n() {
  useSyncExternalStore(subscribe, getLocale)
  return { t, locale: getLocale(), setLocale, locales: LOCALES }
}

// Initialize with the default locale and sync the document once on load
setCoreLocale(getDefaultLocale())
syncDocument()
