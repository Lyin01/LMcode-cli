import { describe, expect, it } from 'vitest'
import {
  isUnsafeRemoteOrUncPath,
  isUnsafeShellOpenPath,
  normalizeOpenPathTarget,
  safeDirectoryDialogPath,
  safeSaveFileName,
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
    expect(normalizeOpenPathTarget('file:///C:/repo/notes.md')).toBe('C:\\repo\\notes.md')
    expect(normalizeOpenPathTarget('file://localhost/C:/repo/notes.md')).toBe('C:\\repo\\notes.md')
    expect(normalizeOpenPathTarget('file:///C:/repo/my%20notes.md')).toBe('C:\\repo\\my notes.md')
  })

  it('rejects relative paths, remote file hosts, and null bytes', () => {
    expect(normalizeOpenPathTarget('notes.md')).toBeNull()
    expect(normalizeOpenPathTarget('./notes.md')).toBeNull()
    expect(normalizeOpenPathTarget('file://evil.example/C:/repo/notes.md')).toBeNull()
    expect(normalizeOpenPathTarget('C:\\repo\\notes.md\0.exe')).toBeNull()
  })
})

describe('dialog path sanitizers', () => {
  it('drops UNC and relative folder-picker defaults', () => {
    expect(safeDirectoryDialogPath(undefined, 'C:\\Users\\me')).toBe('C:\\Users\\me')
    expect(safeDirectoryDialogPath('\\\\evil\\share\\proj', 'C:\\Users\\me')).toBe('C:\\Users\\me')
    expect(safeDirectoryDialogPath('notes', 'C:\\Users\\me')).toBe('C:\\Users\\me')
    expect(safeDirectoryDialogPath('C:\\repo\\app', 'C:\\Users\\me')).toBe('C:\\repo\\app')
  })

  it('keeps only the basename of a save-dialog suggestion', () => {
    expect(safeSaveFileName('export.md')).toBe('export.md')
    expect(safeSaveFileName('C:\\repo\\notes.md')).toBe('notes.md')
    expect(safeSaveFileName('\\\\evil\\share\\loot.txt')).toBe('export.txt')
    expect(safeSaveFileName('   ')).toBe('export.txt')
  })
})
