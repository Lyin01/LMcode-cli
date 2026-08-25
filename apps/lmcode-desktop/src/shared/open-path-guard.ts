/**
 * Windows ShellExecute / Electron `shell.openPath` will run associated
 * handlers for these extensions. Model-controlled tool output must not become
 * a one-click executable.
 */
const UNSAFE_SHELL_OPEN_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'msi',
  'msp',
  'msix',
  'appx',
  'dll',
  'sys',
  'ps1',
  'psm1',
  'psd1',
  'vbs',
  'vbe',
  'jse',
  'js',
  'mjs',
  'cjs',
  'ws',
  'wsf',
  'wsh',
  'wsc',
  'sct',
  'hta',
  'inf',
  'reg',
  'rgs',
  'lnk',
  'url',
  'scf',
  'chm',
  'cpl',
  'msc',
  'jar',
  'gadget',
  'application',
  'appref-ms',
  'search-ms',
  'settingcontent-ms',
])

/**
 * True for UNC / device-namespace paths that would leave the local disk.
 * `\\?\C:\...` is a local extended path and is allowed.
 */
export function isUnsafeRemoteOrUncPath(target: string): boolean {
  const slashes = target.replace(/\//g, '\\')
  if (/^\\\\wsl(\$|\.localhost)\\/i.test(slashes)) return false
  if (/^\\\\[?]\\UNC\\/i.test(slashes)) return true
  if (/^\\\\[.]\\/.test(slashes)) return true
  if (/^\\\\(?![?]\\[A-Za-z]:)/.test(slashes)) return true
  return false
}

/** Strip NTFS ADS and Windows trailing dots/spaces from a basename. */
export function canonicalizeShellOpenBasename(base: string): string {
  let name = base.trim()
  const ads = name.indexOf(':')
  if (ads > 0) name = name.slice(0, ads)
  return name.replace(/[ .]+$/g, '')
}

/** True when `shell.openPath` would treat this absolute path as a program. */
export function isUnsafeShellOpenPath(target: string): boolean {
  const trimmed = target.trim()
  if (trimmed.length === 0) return false
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed
  const name = canonicalizeShellOpenBasename(base)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return UNSAFE_SHELL_OPEN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

function isAbsoluteOpenPath(target: string): boolean {
  if (target.startsWith('/') || target.startsWith('\\')) return true
  return /^[A-Za-z]:[\\/]/.test(target)
}

/**
 * Browser-safe `file://` → local path. Drive-letter URLs become `C:\...`;
 * POSIX URLs keep the decoded pathname. Remote hosts are rejected.
 */
function fileUrlToOpenPath(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl)
    if (url.protocol !== 'file:') return null
    const host = url.hostname.toLowerCase()
    if (host !== '' && host !== 'localhost' && host !== '127.0.0.1') return null
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.includes('\0')) return null
    if (/^\/[A-Za-z][:|]/.test(pathname)) {
      const rest = pathname.slice(3).replace(/\//g, '\\')
      return `${pathname[1]}:${rest.startsWith('\\') ? rest : `\\${rest}`}`
    }
    return pathname
  } catch {
    return null
  }
}

/**
 * Validate and normalize a local path the renderer wants to open: trim,
 * convert `file://`, reject UNC / remote hosts / relative paths.
 *
 * Implemented without Node builtins so the renderer bundle can import the
 * UNC check from this same module.
 */
export function normalizeOpenPathTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return null

  let target = trimmed
  if (trimmed.startsWith('file:')) {
    const converted = fileUrlToOpenPath(trimmed)
    if (converted === null) return null
    target = converted
  }

  if (isUnsafeRemoteOrUncPath(target)) return null
  return isAbsoluteOpenPath(target) ? target : null
}
