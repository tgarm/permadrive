import { useSyncExternalStore } from 'react'
import { getTheme, subscribe, toggleTheme } from '../lib/theme'

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme)
  return (
    <button
      className="btn ghost small theme-toggle"
      onClick={toggleTheme}
      title={`Current theme: ${theme === 'light' ? 'light' : 'dark'}. Click to switch.`}
      aria-label="Toggle color scheme"
    >
      {theme === 'light' ? '☀ Light' : '☾ Dark'}
    </button>
  )
}
