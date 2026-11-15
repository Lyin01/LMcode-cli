export const REDACTED_SECRET_VALUE = '[REDACTED]'

/** HTTPS only, no embedded credentials — matches the window navigation policy. */
export function isSafeExternalHttpsUrl(href: string): boolean {
  try {
    const parsed = new URL(href.trim())
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    )
  } catch {
    return false
  }
}

/**
 * Protocols the desktop hands to the OS on behalf of renderer content.
 *
 * `shell.openExternal` delegates to the platform shell, so `file:` launches
 * local executables, `javascript:`/`data:` are browser sinks, and every other
 * scheme resolves through a registered protocol handler (installers, custom
 * `app://`-style launchers, IDE deep links). Only links a chat transcript can
 * legitimately carry are allowed; everything else is refused at the IPC
 * boundary instead of being normalised and launched.
 */
const EXTERNAL_OPEN_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'mailto:'])

/** Maximum accepted URL length — long enough for any real link, bounded for memory. */
const MAX_EXTERNAL_OPEN_LENGTH = 2_048

/**
 * Normalise a renderer-supplied URL for `shell.openExternal`, or return
 * `undefined` when it must not reach the OS shell at all.
 */
export function parseExternalOpenTarget(href: string): string | undefined {
  const trimmed = href.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_EXTERNAL_OPEN_LENGTH) return undefined

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }

  if (!EXTERNAL_OPEN_PROTOCOLS.has(parsed.protocol)) return undefined

  if (parsed.protocol === 'https:') {
    if (parsed.hostname.length === 0) return undefined
    if (parsed.username.length > 0 || parsed.password.length > 0) return undefined
  }

  return parsed.href
}
