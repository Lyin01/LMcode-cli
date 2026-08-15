import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'
import type { Event } from '@lmcode-cli/lmcode-sdk'

// Sub-agents share the parent session's event stream; every event they emit
// carries their own agentId (the main agent always emits 'main'). Transcript
// events from a sub-agent must never touch the parent's message stream.
const SUB_AGENT = 'agent-0'

function mainEvent<T extends Omit<Event, 'agentId' | 'sessionId'>>(event: T): Event {
  return { ...event, agentId: 'main', sessionId: 'session-a' } as Event
}

function subEvent<T extends Omit<Event, 'agentId' | 'sessionId'>>(event: T): Event {
  return { ...event, agentId: SUB_AGENT, sessionId: 'session-a' } as Event
}

describe('desktop sub-agent event filtering', () => {
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

  it('ignores a sub-agent turn.started instead of opening an empty bubble', () => {
    useSessionStore.getState().handleEvent(
      'session-a',
      subEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }),
    )

    const state = useSessionStore.getState()
    expect(state.messages).toEqual([])
    expect(state.isStreaming).toBe(false)
    expect(state.sessions[0]?.isStreaming).toBe(false)
  })

  it('never patches the main agent bubble with sub-agent deltas', () => {
    const store = useSessionStore.getState()
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }),
    )
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'assistant.delta', turnId: 1, delta: '主 Agent 的回复' }),
    )

    store.handleEvent(
      'session-a',
      subEvent({ type: 'assistant.delta', turnId: 2, delta: '子 Agent 的私语' }),
    )
    store.handleEvent(
      'session-a',
      subEvent({ type: 'thinking.delta', turnId: 2, delta: '子 Agent 的思考' }),
    )
    store.handleEvent(
      'session-a',
      subEvent({
        type: 'tool.call.started',
        turnId: 2,
        toolCallId: 'sub-call-1',
        name: 'Bash',
        args: {},
      }),
    )

    const assistant = useSessionStore.getState().messages.at(-1)
    expect(assistant).toMatchObject({ role: 'assistant', content: '主 Agent 的回复' })
    expect(assistant?.thinking ?? '').toBe('')
    expect(assistant?.toolCalls ?? []).toEqual([])
    expect(useSessionStore.getState().messages).toHaveLength(1)
  })

  it('does not let a sub-agent turn.ended unlock the composer', () => {
    const store = useSessionStore.getState()
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }),
    )
    expect(useSessionStore.getState().isStreaming).toBe(true)

    store.handleEvent(
      'session-a',
      subEvent({ type: 'turn.ended', turnId: 2, reason: 'completed' }),
    )

    const state = useSessionStore.getState()
    expect(state.isStreaming).toBe(true)
    expect(state.sessions[0]?.isStreaming).toBe(true)
  })

  it('does not surface sub-agent failures as parent-session error cards', () => {
    useSessionStore.getState().handleEvent(
      'session-a',
      subEvent({
        type: 'error',
        code: 'internal',
        message: 'sub agent blew up',
        name: 'LmcodeError',
        retryable: false,
        details: {},
      }),
    )
    useSessionStore.getState().handleEvent(
      'session-a',
      subEvent({ type: 'warning', message: 'sub agent warning' }),
    )

    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().isStreaming).toBe(false)
  })

  it('keeps session-level events flowing regardless of agentId', () => {
    const store = useSessionStore.getState()
    store.handleEvent(
      'session-a',
      subEvent({ type: 'agent.status.updated', contextTokens: 123 }),
    )
    store.handleEvent(
      'session-a',
      subEvent({ type: 'session.meta.updated', title: '新标题' }),
    )
    store.handleEvent(
      'session-a',
      subEvent({
        type: 'subagent.spawned',
        subagentId: SUB_AGENT,
        subagentName: 'Explore',
        parentToolCallId: 'tc-1',
        runInBackground: true,
      }),
    )

    const state = useSessionStore.getState()
    expect(state.sessions[0]).toMatchObject({ contextTokens: 123, title: '新标题' })
    expect(state.contextTokens).toBe(123)
    expect(state.messages).toEqual([])
  })

  it('treats events without an agentId field as coming from the main agent', () => {
    const legacy = {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: 'session-a',
    } as unknown as Event
    useSessionStore.getState().handleEvent('session-a', legacy)

    const state = useSessionStore.getState()
    expect(state.isStreaming).toBe(true)
    expect(state.messages).toHaveLength(1)
  })

  it('still processes main-agent transcript events normally', () => {
    const store = useSessionStore.getState()
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }),
    )
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'assistant.delta', turnId: 1, delta: '正文' }),
    )
    store.handleEvent(
      'session-a',
      mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
    )

    const state = useSessionStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: '正文' }),
    ])
  })
})
