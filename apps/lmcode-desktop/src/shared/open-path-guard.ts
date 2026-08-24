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
  'ws',
  'wsf',
  'wsh',
  'hta',
  'inf',
  'reg',
  'rgs',
  'lnk',
  'cpl',
  'msc',
  'jar',
  'gadget',
  'application',
  'appref-ms',
])

/** True when `shell.openPath` would treat this absolute path as a program. */
export function isUnsafeShellOpenPath(target: string): boolean {
  const trimmed = target.trim()
  if (trimmed.length === 0) return false
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  return UNSAFE_SHELL_OPEN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}
