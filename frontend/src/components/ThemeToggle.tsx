import { useSyncExternalStore } from 'react'
import { getTheme, subscribe, toggleTheme } from '../lib/theme'
import { t } from '../i18n'

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme)
  const name = theme === 'light' ? t('theme.light') : t('theme.dark')
  return (
    <button
      className="btn ghost small theme-toggle"
      onClick={toggleTheme}
      title={t('theme.title', [name])}
      aria-label={t('theme.aria')}
    >
      {theme === 'light' ? `☀ ${t('theme.light')}` : `☾ ${t('theme.dark')}`}
    </button>
  )
}
