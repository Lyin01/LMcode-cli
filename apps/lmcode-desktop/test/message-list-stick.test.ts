import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MessageList } from '@/components/MessageList'
import * as sessionStoreModule from '@/stores/session-store'
import type { SessionStore } from '@/stores/session-store'

/**
 * Renders the list against a mocked store and records every selector result,
 * so the test can tell which store slices the component subscribes to.
 */
function captureMessageListSelectors(state: SessionStore): unknown[] {
  const captured: unknown[] = []
  vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(
    ((selector: (store: SessionStore) => unknown) => {
      const value = selector(state)
      captured.push(value)
      return value
    }) as typeof sessionStoreModule.useSessionStore,
  )
  renderToStaticMarkup(createElement(MessageList, { findRequest: null }))
  vi.restoreAllMocks()
  return captured
}

describe('MessageList session switching', () => {
  it('subscribes to the current session so stick-to-bottom resets on switch', () => {
    const base = {
      ...sessionStoreModule.useSessionStore.getState(),
      currentSessionId: 'session-a',
      messages: [],
      isStreaming: false,
      streamStatus: null,
    }
    const sessionA = captureMessageListSelectors(base)
    const sessionB = captureMessageListSelectors({ ...base, currentSessionId: 'session-b' })

    // Switching sessions replaces messages wholesale; without observing
    // currentSessionId the stale stickToBottom flag leaks into session B.
    expect(sessionB.length).toBe(sessionA.length)
    expect(sessionB.some((value, index) => value !== sessionA[index])).toBe(true)
  })
})
