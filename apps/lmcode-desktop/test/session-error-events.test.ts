import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

describe('desktop session error events', () => {
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
      ],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
    })
  })

  it('renders one error card when a failed turn is followed by its matching error event', () => {
    const failure = {
      code: 'internal' as const,
      message: 'Error: terminated',
      name: 'ChatProviderError',
      retryable: false,
      details: { turnId: 1 },
    }
    const store = useSessionStore.getState()
    store.handleEvent('session-a', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'agent-a',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'failed',
      error: failure,
      agentId: 'agent-a',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'error',
      ...failure,
      agentId: 'agent-a',
      sessionId: 'session-a',
    })

    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: false,
      messages: [
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          role: 'system',
          variant: 'error',
          content: '回合失败：Error: terminated',
        }),
      ],
    })
  })

  it('keeps standalone error events visible', () => {
    useSessionStore.getState().handleEvent('session-a', {
      type: 'error',
      code: 'internal',
      message: 'Session is busy',
      name: 'LmcodeError',
      retryable: true,
      details: {},
      agentId: 'agent-a',
      sessionId: 'session-a',
    })

    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({
        role: 'system',
        variant: 'error',
        content: '出错了：Session is busy（可重试）',
      }),
    ])
  })
})
