import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@/components/Sidebar'
import * as sessionStoreModule from '@/stores/session-store'
import type { SessionStore } from '@/stores/session-store'

const sidebarProps = {
  open: true,
  onToggle: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenMemory: vi.fn(),
  onOpenExtensions: vi.fn(),
  searchRequestNonce: 0,
  renameRequest: null,
}

let sidebarState: SessionStore

describe('desktop sidebar accessibility contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sidebarState = {
      ...sessionStoreModule.useSessionStore.getState(),
      currentSessionId: 'session-a',
      sessions: [
        {
          id: 'session-a',
          title: '发布检查',
          workDir: 'C:/work',
          createdAt: 1,
          updatedAt: 1,
          thinkingLevel: 'medium',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 128_000,
          isStreaming: false,
        },
      ],
      isStreaming: false,
      bg: {},
    }
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(
      ((selector) => selector(sidebarState)) as typeof sessionStoreModule.useSessionStore,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders task navigation and the consolidated action menu with accessible names', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('aria-label="任务侧栏"')
    expect(html).toContain('aria-label="收起侧栏"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="打开任务操作：发布检查"')
  })

  it('exposes the active generation state to assistive technology', () => {
    sidebarState = { ...sidebarState, isStreaming: true }

    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在生成"')
  })

  it('renders project groups expanded by default with a collapse toggle', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="折叠项目 work 的任务"')
    expect(html).toContain('发布检查')
  })

  it('restores collapsed project groups from storage and hides their sessions', () => {
    const values = new Map<string, string>([
      ['lmcode-sidebar-collapsed-projects', JSON.stringify(['C:/work'])],
    ])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    })

    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="展开项目 work 的任务"')
    // The collapsed group header (and its count) stays visible; sessions do not.
    expect(html).not.toContain('发布检查')
    // The current session lives in the collapsed group: surface a locator hint.
    expect(html).toContain('title="当前任务在此项目中"')
  })
})
