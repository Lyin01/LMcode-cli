import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

describe('desktop background session results', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: 'session-a',
      sessions: [
        {
          id: 'session-a',
          workDir: 'C:/repo-a',
          createdAt: 1,
          updatedAt: 1,
          thinkingLevel: 'medium',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 1_000,
          isStreaming: false,
        },
        {
          id: 'session-b',
          workDir: 'C:/repo-b',
          createdAt: 1,
          updatedAt: 1,
          thinkingLevel: 'medium',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 1_000,
          isStreaming: false,
        },
      ],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
    })
  })

  it('marks a finished off-screen turn unread and clears the marker when selected', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-b', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-b',
    })
    store.handleEvent('session-b', {
      type: 'assistant.delta',
      turnId: 1,
      delta: 'Scheduled result',
      agentId: 'main',
      sessionId: 'session-b',
    })
    store.handleEvent('session-b', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      agentId: 'main',
      sessionId: 'session-b',
    })

    expect(useSessionStore.getState().bg['session-b']).toMatchObject({
      unread: true,
      isStreaming: false,
      messages: [expect.objectContaining({ role: 'assistant', content: 'Scheduled result' })],
    })

    useSessionStore.getState().selectSession('session-b')

    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Scheduled result' }),
    ])
    expect(useSessionStore.getState().bg['session-b']).toBeUndefined()
  })

  it('parks streaming events for a session not yet in the session list', () => {
    const store = useSessionStore.getState()
    store.handleEvent('cron-session', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'cron-session',
    })
    store.handleEvent('cron-session', {
      type: 'assistant.delta',
      turnId: 1,
      delta: 'Scheduled result',
      agentId: 'main',
      sessionId: 'cron-session',
    })

    expect(useSessionStore.getState().bg['cron-session']).toMatchObject({
      unread: true,
      messages: [expect.objectContaining({ role: 'assistant', content: 'Scheduled result' })],
    })
  })

  it('drops streaming events for a session that was deleted', () => {
    const store = useSessionStore.getState()
    store.removeDeletedSession('session-b', [
      useSessionStore.getState().sessions.find((session) => session.id === 'session-a')!,
    ])
    store.handleEvent('session-b', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-b',
    })

    expect(useSessionStore.getState().bg['session-b']).toBeUndefined()
  })

  it('does not resurrect a deleted session when listSessions still returns it', () => {
    const store = useSessionStore.getState()
    const leftover = {
      id: 'session-b',
      workDir: 'C:/repo-b',
      createdAt: 1,
      updatedAt: 1,
      thinkingLevel: 'medium' as const,
      permission: 'manual' as const,
      contextTokens: 0,
      maxContextTokens: 1_000,
      isStreaming: false,
    }
    store.removeDeletedSession('session-b', [
      store.sessions.find((session) => session.id === 'session-a')!,
      leftover,
    ])

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['session-a'])

    store.setSessions([
      store.sessions.find((session) => session.id === 'session-a')!,
      leftover,
    ])
    store.setSessionStreaming('session-b', true)
    store.enqueueMessage('session-b', 'should not queue')
    store.handleEvent('session-b', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-b',
    })

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['session-a'])
    expect(useSessionStore.getState().bg['session-b']).toBeUndefined()
    expect(useSessionStore.getState().messageQueue['session-b']).toBeUndefined()
  })

  it('keeps delayed user-facing errors with the session that produced them', () => {
    useSessionStore.setState({ isStreaming: true })
    useSessionStore.getState().addMessageToSession('session-b', {
      id: 'error-b',
      role: 'system',
      variant: 'error',
      content: 'Background send failed',
      timestamp: 2,
    })

    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().bg['session-b']).toMatchObject({
      unread: true,
      messages: [expect.objectContaining({ id: 'error-b' })],
    })

    useSessionStore.getState().setSessionStreaming('session-b', false)
    expect(useSessionStore.getState().isStreaming).toBe(true)
    expect(useSessionStore.getState().bg['session-b']?.isStreaming).toBe(false)

    useSessionStore.getState().setMessagesForSession('session-b', [{
      id: 'history-b',
      role: 'assistant',
      content: 'Restored history',
      timestamp: 3,
    }])
    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().bg['session-b']?.messages).toEqual([
      expect.objectContaining({ id: 'history-b' }),
    ])
  })
})
