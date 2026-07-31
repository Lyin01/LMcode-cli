import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getStoredCollapsedProjects,
  getStoredSidebarOpen,
  setStoredCollapsedProjects,
  setStoredSidebarOpen,
} from '../src/renderer/lib/sidebar-preference'

describe('desktop sidebar preference', () => {
  const values = new Map<string, string>()

  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults open and restores the last explicit sidebar state', () => {
    expect(getStoredSidebarOpen()).toBe(true)

    setStoredSidebarOpen(false)
    expect(getStoredSidebarOpen()).toBe(false)

    setStoredSidebarOpen(true)
    expect(getStoredSidebarOpen()).toBe(true)
  })

  it('keeps the safe default when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('storage disabled')
      }),
      setItem: vi.fn(() => {
        throw new Error('storage disabled')
      }),
    })

    expect(getStoredSidebarOpen()).toBe(true)
    expect(() => setStoredSidebarOpen(false)).not.toThrow()
    expect(getStoredCollapsedProjects().size).toBe(0)
    expect(() => setStoredCollapsedProjects(new Set(['C:/work']))).not.toThrow()
  })

  it('round-trips collapsed project groups', () => {
    expect(getStoredCollapsedProjects().size).toBe(0)

    setStoredCollapsedProjects(new Set(['C:/work', 'D:/repo']))
    expect([...getStoredCollapsedProjects()].sort()).toEqual(['C:/work', 'D:/repo'])

    setStoredCollapsedProjects(new Set())
    expect(getStoredCollapsedProjects().size).toBe(0)
  })

  it('ignores corrupted or non-string collapsed-project payloads', () => {
    values.set('lmcode-sidebar-collapsed-projects', '{not json')
    expect(getStoredCollapsedProjects().size).toBe(0)

    values.set('lmcode-sidebar-collapsed-projects', JSON.stringify(['C:/work', 42, null]))
    expect([...getStoredCollapsedProjects()]).toEqual(['C:/work'])
  })
})
