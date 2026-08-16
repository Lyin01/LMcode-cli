/**
 * 「输出文件可点击」的目标识别：判断一段行内文本是否指向可打开的本地文件。
 *
 * 与旧版行为保持一致：file:// 链接、Windows 盘符路径（E:\a\b 或 E:/a/b）、
 * Unix 风格绝对路径（/e/a/b）。相对路径不识别，避免误把普通片段当文件打开。
 */

export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

/** file:///C:/a/b → C:\a\b；非 file:// 协议或无法解析时返回 null。 */
export function fileUrlToLocalPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') return null
  const pathname = decodeURIComponent(parsed.pathname)
  return /^\/[A-Za-z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname
}

/** 命中则返回归一化后的本地路径，否则 null。 */
export function resolveOpenTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('file://')) return fileUrlToLocalPath(trimmed)
  return isWindowsPath(trimmed) || trimmed.startsWith('/') ? trimmed : null
}
