import { describe, expect, it } from 'vitest'
import {
  isUnsafeRemoteOrUncPath,
  isUnsafeShellOpenPath,
  normalizeOpenPathTarget,
} from '../src/shared/open-path-guard'

describe('isUnsafeShellOpenPath', () => {
  it('rejects Windows executables and installer/script associations', () => {
    expect(isUnsafeShellOpenPath('C:\\Users\\me\\payload.exe')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\run.BAT')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\run.cmd')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\hook.ps1')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\drop.msi')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\shortcut.lnk')).toBe(true)
    expect(isUnsafeShellOpenPath('\\\\share\\malware.vbs')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\repo\\app.js')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\open.url')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\payload.exe.')).toBe(true)
    expect(isUnsafeShellOpenPath('C:\\tmp\\payload.exe::$DATA')).toBe(true)
  })

  it('allows documents and source files the chip UI is meant to open', () => {
    expect(isUnsafeShellOpenPath('C:\\repo\\index.html')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\notes.md')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\app.ts')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\photo.png')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\.bashrc')).toBe(false)
    expect(isUnsafeShellOpenPath('C:\\repo\\README')).toBe(false)
  })
})

describe('normalizeOpenPathTarget', () => {
  it('rejects UNC and remote file hosts that would leak NTLM or leave the disk', () => {
    expect(normalizeOpenPathTarget('\\\\evil\\share\\notes.txt')).toBeNull()
    expect(isUnsafeRemoteOrUncPath('\\\\evil\\share\\notes.txt')).toBe(true)
    expect(isUnsafeRemoteOrUncPath('\\\\wsl$\\Ubuntu\\home\\me\\app.ts')).toBe(false)
  })

  it('accepts a local absolute path and a localhost file URL', () => {
    expect(normalizeOpenPathTarget('C:\\repo\\notes.md')).toBe('C:\\repo\\notes.md')
    const fromUrl = normalizeOpenPathTarget('file:///C:/repo/notes.md')
    expect(fromUrl === 'C:\\repo\\notes.md' || fromUrl === 'C:/repo/notes.md').toBe(true)
  })
})
