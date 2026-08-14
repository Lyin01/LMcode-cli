import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'
import type { SessionInfo } from '../src/renderer/types'

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

async function flushDrain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('desktop message queue drain', () => {
  const sendMessage = vi.fn<(sessionId: string, request: { text: string }) => Promise<void>>(
    () => Promise.resolve(),
  )

  beforeEach(() => {
    sendMessage.mockClear()
    vi.stubGlobal('window', { lmcodeAPI: { sendMessage } })
    useSessionStore.setState({
      currentSessionId: 'session-a',
      sessions: [session('session-a'), session('session-b')],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
      messageQueue: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a queued message automatically once the session is idle', async () => {
    useSessionStore.getState().enqueueMessage('session-a', 'queued follow-up')
    await flushDrain()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toBe('session-a')
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: 'queued follow-up' })

    const state = useSessionStore.getState()
    expect(state.messageQueue['session-a'] ?? []).toHaveLength(0)
    expect(state.isStreaming).toBe(true)
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'queued follow-up' }),
    ])
  })

  it('drains at most one message per turn even when triggered twice in the same commit', async () => {
    const store = useSessionStore.getState()
    store.enqueueMessage('session-a', 'first')
    store.enqueueMessage('session-a', 'second')

    // Simulates two mounted hook instances racing the same drain window:
    // the store-level guard must let only one send through.
    store.drainMessageQueue('session-a')
    store.drainMessageQueue('session-a')
    await flushDrain()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: 'first' })
    expect(useSessionStore.getState().messageQueue['session-a']).toHaveLength(1)
  })

  it('continues draining queued messages in FIFO order as turns end', async () => {
    const store = useSessionStore.getState()
    store.enqueueMessage('session-a', 'first')
    store.enqueueMessage('session-a', 'second')
    await flushDrain()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    useSessionStore.getState().handleEvent('session-a', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      agentId: 'main',
      sessionId: 'session-a',
    })
    await flushDrain()

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: 'first' })
    expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({ text: 'second' })
    expect(useSessionStore.getState().messageQueue['session-a'] ?? []).toHaveLength(0)
  })

  it('drains a background session queue when its off-screen turn finishes', async () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-b', {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'session-b',
    })
    store.enqueueMessage('session-b', 'background follow-up')
    await flushDrain()
    expect(sendMessage).not.toHaveBeenCalled()

    useSessionStore.getState().handleEvent('session-b', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      agentId: 'main',
      sessionId: 'session-b',
    })
    await flushDrain()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toBe('session-b')
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: 'background follow-up' })

    const bg = useSessionStore.getState().bg['session-b']
    expect(bg?.isStreaming).toBe(true)
    expect(bg?.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'background follow-up' }),
    )
    // The foreground session view must stay untouched.
    expect(useSessionStore.getState().messages).toEqual([])
  })

  it('does not raise the unread badge for the user\'s own queued background message', async () => {
    const store = useSessionStore.getState()
    store.enqueueMessage('session-b', 'background follow-up')
    await flushDrain()

    // The user sent this message themselves — they already know about it.
    const bg = useSessionStore.getState().bg['session-b']
    expect(bg?.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'background follow-up' }),
    )
    expect(bg?.unread).toBe(false)

    // The assistant's reply is new information and must still flag the session.
    useSessionStore.getState().handleEvent('session-b', {
      type: 'assistant.delta',
      turnId: 1,
      delta: '后台回复',
      agentId: 'main',
      sessionId: 'session-b',
    })
    expect(useSessionStore.getState().bg['session-b']?.unread).toBe(true)
  })

  it('never drains sessions that are not in the session list', async () => {
    useSessionStore.getState().enqueueMessage('ghost-session', 'never sent')
    await flushDrain()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().messageQueue['ghost-session']).toHaveLength(1)
  })
})
