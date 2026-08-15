import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'
import type { Message, SessionInfo } from '../src/renderer/types'

function session(id: string): SessionInfo {
  return {
    id,
    workDir: `C:/repo-${id}`,
    createdAt: 1,
    updatedAt: 1,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 1_000,
    isStreaming: false,
  }
}

function historyMessage(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: 1 }
}

describe('desktop session history hydration', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: 'session-a',
      sessions: [session('session-a'), session('session-b')],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
      hydratedSessions: {},
    })
  })

  it('applies backfilled history once and marks the session hydrated', () => {
    useSessionStore
      .getState()
      .hydrateSessionHistory('session-a', [historyMessage('h1', 'old reply')])

    const state = useSessionStore.getState()
    expect(state.messages).toEqual([expect.objectContaining({ id: 'h1' })])
    expect(state.hydratedSessions['session-a']).toBe(true)
  })

  it('merges late-arriving history before messages sent while it was loading', () => {
    // The user selected an old session and sent a message before
    // getSessionHistory resolved. The backfill must still land — ordered
    // before the live traffic — instead of being dropped forever.
    useSessionStore.getState().addMessageToSession('session-a', {
      id: 'live-1',
      role: 'user',
      content: 'sent during backfill',
      timestamp: 2,
    })

    useSessionStore
      .getState()
      .hydrateSessionHistory('session-a', [
        historyMessage('h1', 'older'),
        historyMessage('h2', 'newer'),
      ])

    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual([
      'h1',
      'h2',
      'live-1',
    ])
  })

  it('ignores later hydration attempts for an already hydrated session', () => {
    const store = useSessionStore.getState()
    store.hydrateSessionHistory('session-a', [historyMessage('h1', 'first pass')])
    store.hydrateSessionHistory('session-a', [historyMessage('h2', 'second pass')])

    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual(['h1'])
  })

  it('routes history into the background slice when the session left the view', () => {
    useSessionStore.getState().selectSession('session-b')
    useSessionStore
      .getState()
      .hydrateSessionHistory('session-a', [historyMessage('h1', 'parked history')])

    const state = useSessionStore.getState()
    expect(state.messages).toEqual([])
    expect(state.bg['session-a']?.messages).toEqual([expect.objectContaining({ id: 'h1' })])
    expect(state.bg['session-a']?.unread).toBe(false)
    expect(state.hydratedSessions['session-a']).toBe(true)
  })

  it('marks adopted sessions as hydrated so their first turn is never duplicated', () => {
    useSessionStore.getState().adoptSession({
      id: 'session-c',
      workDir: 'C:/repo-c',
      sessionDir: 'C:/repo-c/.lmcode',
      createdAt: 1,
      updatedAt: 1,
    })

    const state = useSessionStore.getState()
    expect(state.currentSessionId).toBe('session-c')
    expect(state.hydratedSessions['session-c']).toBe(true)
  })

  it('ignores late history for a session deleted while the backfill was in flight', () => {
    // removeDeletedSession already cleared the bg slice and hydration marker;
    // a tardy getSessionHistory resolution must not resurrect either one.
    useSessionStore
      .getState()
      .hydrateSessionHistory('ghost-session', [historyMessage('h1', 'stale history')])

    const state = useSessionStore.getState()
    expect(state.bg['ghost-session']).toBeUndefined()
    expect(state.hydratedSessions['ghost-session']).toBeUndefined()
    expect(state.messages).toEqual([])
  })

  it('clears the hydration marker when the session is deleted', () => {
    const store = useSessionStore.getState()
    store.hydrateSessionHistory('session-a', [historyMessage('h1', 'old reply')])
    store.removeDeletedSession('session-a', [session('session-b')])

    expect(useSessionStore.getState().hydratedSessions['session-a']).toBeUndefined()
  })
})
