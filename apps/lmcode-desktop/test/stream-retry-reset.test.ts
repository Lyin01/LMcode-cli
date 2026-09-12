import type { Event } from '@lmcode-cli/lmcode-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

function sessionEvent(payload: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: 'session-a', ...payload } as Event
}

describe('desktop stream retry rewind', () => {
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
      isStreaming: true,
      streamStatus: null,
      stepBaseline: null,
      bg: {},
    })
  })

  it('rewinds the partial assistant output of the failed attempt', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', sessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }))
    store.handleEvent('session-a', sessionEvent({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 's1' }))
    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'failed attempt text' }))
    store.handleEvent(
      'session-a',
      sessionEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        args: { command: 'ls' },
      }),
    )
    store.handleEvent(
      'session-a',
      sessionEvent({
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        argumentsPart: '{"command":"ls',
      }),
    )

    store.handleEvent(
      'session-a',
      sessionEvent({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        stepId: 's1',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 10,
        errorName: 'APIConnectionError',
        errorMessage: 'socket hang up',
      }),
    )

    const rewound = useSessionStore.getState().messages.at(-1)
    expect(rewound).toMatchObject({ role: 'assistant', content: '', toolCalls: [] })

    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'final answer' }))
    expect(useSessionStore.getState().messages.at(-1)?.content).toBe('final answer')
  })

  it('keeps text committed by earlier steps when a later step retries', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', sessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }))
    store.handleEvent('session-a', sessionEvent({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 's1' }))
    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'step one answer. ' }))
    store.handleEvent('session-a', sessionEvent({ type: 'turn.step.started', turnId: 1, step: 2, stepId: 's2' }))
    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'step two partial' }))

    store.handleEvent(
      'session-a',
      sessionEvent({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 2,
        stepId: 's2',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 10,
        errorName: 'APIConnectionError',
        errorMessage: 'socket hang up',
      }),
    )
    expect(useSessionStore.getState().messages.at(-1)?.content).toBe('step one answer. ')

    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'step two final' }))
    expect(useSessionStore.getState().messages.at(-1)?.content).toBe('step one answer. step two final')
  })

  it('keeps the rewind baseline across a session switch', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', sessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }))
    store.handleEvent('session-a', sessionEvent({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 's1' }))
    store.handleEvent('session-a', sessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'partial one' }))

    // Park the streaming session and come back: the step baseline must survive
    // the background-slice round trip, or the retry can no longer rewind.
    store.selectSession('session-b')
    store.selectSession('session-a')

    store.handleEvent(
      'session-a',
      sessionEvent({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        stepId: 's1',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 10,
        errorName: 'APIConnectionError',
        errorMessage: 'socket hang up',
      }),
    )

    expect(useSessionStore.getState().messages.at(-1)?.content).toBe('')
  })
})
