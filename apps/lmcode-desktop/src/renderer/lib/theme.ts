export type ThemePref = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'lmcode-theme'

/** Resolve a preference to the concrete theme actually applied. */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Apply a theme preference to the document and persist it for next launch. */
export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* storage may be unavailable */
  }
}

/** Read the persisted preference (defaults to warm light, Claude-style). */
export function getStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'light'
}
