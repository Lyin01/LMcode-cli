import { describe, expect, it } from 'vitest'
import { isUnsafeShellOpenPath } from '../src/shared/open-path-guard'

describe('isUnsafeShellOpenPath', () => {
  it('rejects Windows executables and installer/script associations', () => {
    expect(isUnsafeShellOpenPath('C:\\Users\\me\\payload.exe')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\run.BAT')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\run.cmd')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\hook.ps1')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\drop.msi')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\shortcut.lnk')).toBe(true)
    expect(isUnsafeShellOpenPath('\\\\share\\malware.vbs')).toBe(true)
  })

  it('allows documents and source files the chip UI is meant to open', () => {
    expect(isUnsafeShellOpenPath('C:\\repo\\index.html')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\notes.md')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\app.js')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\photo.png')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\.bashrc')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\README')).toBe(false)
  })
})
