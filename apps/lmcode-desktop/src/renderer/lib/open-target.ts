/**
 * 「输出文件可点击」的目标识别：判断一段行内文本是否指向可打开的本地文件。
 *
 * 支持 file://、Windows/Unix 绝对路径，以及基于当前会话工作目录解析的
 * 文件型相对路径。Windows 下也识别 Git Bash/MSYS 输出的 /c/Users/...。
 */

export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function isWindowsBasePath(value: string): boolean {
  return isWindowsPath(value) || value.startsWith('\\\\')
}

function isAbsoluteLocalPath(value: string): boolean {
  return isWindowsBasePath(value) || value.startsWith('/')
}

function looksLikeRelativeFilePath(value: string): boolean {
  if (value.includes('\0') || /[\r\n]/.test(value) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) {
    return false
  }
  if (/^\.\.?[\\/]/.test(value) || /[\\/]/.test(value)) return true
  return /^[^\s\\/]+\.[A-Za-z\d][A-Za-z\d._-]{0,15}$/.test(value)
}

function resolveRelativePath(baseDir: string, relativePath: string): string | null {
  const windows = isWindowsBasePath(baseDir)
  if (!windows && !baseDir.startsWith('/')) return null

  const separator = windows ? '\\' : '/'
  let prefix: string
  let floor = 0
  let baseRemainder: string

  if (isWindowsPath(baseDir)) {
    prefix = `${baseDir.slice(0, 2)}\\`
    baseRemainder = baseDir.slice(3)
  } else if (baseDir.startsWith('\\\\')) {
    prefix = '\\\\'
    baseRemainder = baseDir.slice(2)
    floor = 2
  } else {
    prefix = '/'
    baseRemainder = baseDir.slice(1)
  }

  const segments = baseRemainder.split(/[\\/]+/).filter(Boolean)
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > floor) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${prefix}${segments.join(separator)}`
}

function msysPathToWindowsPath(value: string, baseDir?: string): string | null {
  if (baseDir === undefined || !isWindowsBasePath(baseDir)) return null
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value)
  if (match === null) return null
  const remainder = (match[2] ?? '').replaceAll('/', '\\')
  return `${match[1]!.toUpperCase()}:\\${remainder}`
}

/** file:///C:/a/b → C:\a\b；非 file:// 协议或无法解析时返回 null。 */
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

/** 从绝对路径取出文件名，供产物卡片展示。 */
export function fileBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.at(-1) ?? path
}

/**
 * Markdown / HTML href：本地文件（含相对路径、file://）解析成可打开路径；
 * http(s)、mailto、锚点交给原来的链接逻辑。
 */
export function resolveHrefOpenTarget(href: string, baseDir?: string): string | null {
  const trimmed = href.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('#') || trimmed.startsWith('mailto:')) return null
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed) && !trimmed.startsWith('file:')) return null
  return resolveOpenTarget(trimmed, baseDir)
}

/** 命中则返回可交给 Electron 打开的绝对本地路径，否则 null。 */
export function resolveOpenTarget(raw: string, baseDir?: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return null
  if (trimmed.startsWith('file://')) return fileUrlToLocalPath(trimmed)
  const windowsShellPath = msysPathToWindowsPath(trimmed, baseDir)
  if (windowsShellPath !== null) return windowsShellPath
  if (isAbsoluteLocalPath(trimmed)) return trimmed
  if (baseDir === undefined || !looksLikeRelativeFilePath(trimmed)) return null
  return resolveRelativePath(baseDir.trim(), trimmed)
}
