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

  it('renders session navigation and icon actions with accessible names', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('aria-label="会话侧栏"')
    expect(html).toContain('aria-label="收起侧栏"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="导出会话：发布检查"')
    expect(html).toContain('aria-label="删除会话：发布检查"')
  })

  it('exposes the active generation state to assistive technology', () => {
    sidebarState = { ...sidebarState, isStreaming: true }

    const html = renderToStaticMarkup(createElement(Sidebar, sidebarProps))

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在生成"')
  })
})
