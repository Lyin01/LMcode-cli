import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

describe('desktop tool progress events', () => {
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

  it('shows interim tool updates on the running tool card instead of dropping them', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 'call-1',
      name: 'Write',
      args: {},
      agentId: 'main',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'call-1',
      update: { kind: 'status', text: '正在运行浏览器校验…' },
      agentId: 'main',
      sessionId: 'session-a',
    })

    const toolCall = useSessionStore.getState().messages[0]?.toolCalls?.[0]
    expect(toolCall).toMatchObject({
      status: 'running',
      progress: '正在运行浏览器校验…',
    })
  })

  it('renders percent-only updates and ignores updates without displayable text', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 'call-1',
      name: 'Bash',
      args: {},
      agentId: 'main',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'call-1',
      update: { kind: 'progress', percent: 42.4 },
      agentId: 'main',
      sessionId: 'session-a',
    })
    expect(useSessionStore.getState().messages[0]?.toolCalls?.[0]?.progress).toBe('42%')

    const before = useSessionStore.getState().messages
    store.handleEvent('session-a', {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'call-1',
      update: { kind: 'custom', customKind: 'ping' },
      agentId: 'main',
      sessionId: 'session-a',
    })
    expect(useSessionStore.getState().messages).toBe(before)
    expect(useSessionStore.getState().messages[0]?.toolCalls?.[0]?.progress).toBe('42%')
  })

  it('records startedAt on tool start and endedAt on tool result', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-a', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-a',
    })
    store.handleEvent('session-a', {
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 'call-1',
      name: 'Read',
      args: { path: 'a.ts' },
      agentId: 'main',
      sessionId: 'session-a',
    })

    const started = useSessionStore.getState().messages[0]?.toolCalls?.[0]
    expect(started?.startedAt).toBeTypeOf('number')
    expect(started?.endedAt).toBeUndefined()

    const startedAt = started?.startedAt ?? 0
    store.handleEvent('session-a', {
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'call-1',
      output: 'ok',
      isError: false,
      agentId: 'main',
      sessionId: 'session-a',
    })

    const finished = useSessionStore.getState().messages[0]?.toolCalls?.[0]
    expect(finished?.status).toBe('completed')
    expect(finished?.endedAt).toBeTypeOf('number')
    expect(finished?.endedAt).toBeGreaterThanOrEqual(startedAt)
  })
})
