import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxPanel } from '@/components/InboxPanel'
import * as inboxStoreModule from '@/stores/inbox-store'
import type { InboxStore } from '@/stores/inbox-store'

let inboxState: InboxStore

describe('desktop inbox drawer accessibility contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inboxState = { ...inboxStoreModule.useInboxStore.getState(), items: [] }
    // renderToStaticMarkup resolves zustand's server snapshot (the store's
    // initial state), so the drawer contract tests drive a fixture state
    // through the hook instead — same pattern as the sidebar tests.
    vi.spyOn(inboxStoreModule, 'useInboxStore').mockImplementation(
      ((selector) => selector(inboxState)) as typeof inboxStoreModule.useInboxStore,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is a named modal dialog with labelled controls and an empty state', () => {
    const html = renderToStaticMarkup(
      createElement(InboxPanel, { open: true, onClose: vi.fn() }),
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="lm-inbox-panel-title"')
    expect(html).toContain('id="lm-inbox-panel-title"')
    expect(html).toContain('aria-label="关闭通知中心"')
    expect(html).toContain('title="关闭通知中心"')
    expect(html).toContain('aria-label="全部标为已读"')
    expect(html).toContain('aria-label="清空通知"')
    expect(html).toContain('data-lm-autofocus="true"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('没有新通知')
  })

  it('renders entries as buttons showing the title and unread affordances', () => {
    inboxState = {
      ...inboxState,
      items: [
        {
          id: 'inbox-1',
          type: 'turn-completed',
          sessionId: 'session-a',
          title: '回合已完成：后台任务',
          createdAt: Date.now(),
          read: false,
          outcome: 'success',
        },
      ],
    }

    const html = renderToStaticMarkup(
      createElement(InboxPanel, { open: true, onClose: vi.fn() }),
    )

    expect(html).toContain('回合已完成：后台任务')
    expect(html).toContain('1 未读')
    // 条目可点击（button）且未读高亮标记存在
    expect(html).toContain('<button type="button"')
  })

  it('renders nothing while closed', () => {
    expect(
      renderToStaticMarkup(createElement(InboxPanel, { open: false, onClose: vi.fn() })),
    ).toBe('')
  })
})
