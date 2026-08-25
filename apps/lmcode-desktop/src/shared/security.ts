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
