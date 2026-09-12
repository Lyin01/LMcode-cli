import { readPairingToken } from '../shared/remote-pairing'

const TOKEN_STORAGE_KEY = 'lmcode.remote.token'

/**
 * Resolve the pairing token for this page load: a `#token=...` fragment from
 * the scanned QR wins (it is saved and stripped from the address bar so a
 * screenshot or a re-shared URL cannot leak it), otherwise the token stored on
 * this device is reused.
 */
export function resolveInitialToken(): string | null {
  const fromFragment = readPairingToken(window.location.hash)
  if (fromFragment !== null) {
    saveToken(fromFragment)
    clearLocationFragment()
    return fromFragment
  }
  return loadToken()
}

export function loadToken(): string | null {
  try {
    const value = window.localStorage.getItem(TOKEN_STORAGE_KEY)
    return value !== null && value.trim().length > 0 ? value : null
  } catch {
    // Storage can be unavailable (private mode, embedded webviews).
    return null
  }
}

export function saveToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Best effort: pairing still works for this page load.
  }
}

export function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // Best effort.
  }
}

function clearLocationFragment(): void {
  if (window.location.hash.length === 0) return
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
}
