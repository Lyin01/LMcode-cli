/** Identify local absolute paths that can be opened from rendered messages. */

export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

export function fileUrlToLocalPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    const pathname = decodeURIComponent(parsed.pathname)
    return /^\/[A-Za-z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

export function resolveOpenTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('file://')) return fileUrlToLocalPath(trimmed)
  return isWindowsPath(trimmed) || trimmed.startsWith('/') ? trimmed : null
}
