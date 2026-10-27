// Language select (same interaction as the ai3-xdm-bridge LanguageSelect):
// options are self-named (English / 中文); switching persists to localStorage
// and applies app-wide immediately.

import { useI18n, type Locale } from '../i18n'

const languageNames: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
}

export function LanguageSelect() {
  const { locale, setLocale, locales } = useI18n()
  return (
    <select
      className="lang-select"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label="Language"
    >
      {locales.map((l) => (
        <option key={l} value={l}>
          {languageNames[l]}
        </option>
      ))}
    </select>
  )
}
