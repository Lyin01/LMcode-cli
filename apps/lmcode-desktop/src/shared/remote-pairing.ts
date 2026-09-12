/**
 * Pairing-URL helpers shared by the desktop settings panel (QR code / copy
 * link) and the built-in mobile page served by the remote service.
 *
 * The token travels in the URL fragment: fragments are never sent to the
 * server, so the token stays out of HTTP access logs and referrer headers.
 * The mobile page reads the fragment, stores the token locally and strips it
 * from the address bar.
 */

/** Append the pairing token as a fragment to a LAN / tunnel base URL. */
export function buildPairingUrl(baseUrl: string, token: string): string {
  return `${normalizePairingBase(baseUrl)}#token=${encodeURIComponent(token)}`
}

/**
 * Read the pairing token from a `location.hash` value (with or without the
 * leading `#`). Returns `null` when the fragment carries no usable token.
 */
export function readPairingToken(rawFragment: string): string | null {
  const fragment = rawFragment.startsWith('#') ? rawFragment.slice(1) : rawFragment
  if (fragment.length === 0) return null
  const token = new URLSearchParams(fragment).get('token')
  if (token === null) return null
  const trimmed = token.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Drop an existing `#fragment` / `?query` and trailing slashes from the base. */
function normalizePairingBase(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
}

/** Structural subset of the main-process `RemoteState` needed for pairing. */
export interface PairingTargetState {
  readonly enabled: boolean
  readonly lanUrls: readonly string[]
  readonly token: string
}

/**
 * The URL the pairing QR code should encode, or `null` when the service is off
 * or has no LAN address to point at. Shared by the settings remote panel and
 * the remote connect dialog so both surfaces show the same target.
 */
export function pairingQrUrl(state: PairingTargetState): string | null {
  if (!state.enabled) return null
  const baseUrl = state.lanUrls[0]
  if (baseUrl === undefined || baseUrl.length === 0) return null
  return buildPairingUrl(baseUrl, state.token)
}
