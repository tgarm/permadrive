// Dual theme: dark is the baseline, light is enabled via html[data-theme='light'].
// An explicit choice persists in localStorage('theme'); otherwise the system
// prefers-color-scheme is followed. The inline script in index.html sets
// data-theme before first paint to avoid a flash — keep its logic in sync here.

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'theme'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // localStorage unavailable (e.g. private mode): follow the system
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

let theme = initialTheme()

const listeners = new Set<() => void>()

export function getTheme(): Theme {
  return theme
}

export function setTheme(next: Theme) {
  theme = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // persistence failure must not affect the current session
  }
  document.documentElement.dataset.theme = next
  listeners.forEach((fn) => fn())
}

export function toggleTheme() {
  setTheme(theme === 'dark' ? 'light' : 'dark')
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
