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
      agentId: 'agent-b',
      sessionId: 'session-b',
    })
    store.handleEvent('session-b', {
      type: 'assistant.delta',
      turnId: 1,
      delta: 'Scheduled result',
      agentId: 'agent-b',
      sessionId: 'session-b',
    })
    store.handleEvent('session-b', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      agentId: 'agent-b',
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
