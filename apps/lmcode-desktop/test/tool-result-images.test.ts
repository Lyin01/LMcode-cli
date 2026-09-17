import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

const SCREENSHOT_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SECOND_URL = 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

/** Drive the store the way the live event stream does: turn → tool call → result. */
function startToolCall(): void {
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
    name: 'ComputerUse',
    args: { action: 'screenshot' },
    agentId: 'main',
    sessionId: 'session-a',
  })
}

function resolveToolCall(output: unknown): void {
  useSessionStore.getState().handleEvent('session-a', {
    type: 'tool.result',
    turnId: 1,
    toolCallId: 'call-1',
    output,
    isError: false,
    agentId: 'main',
    sessionId: 'session-a',
  })
}

function lastToolCall() {
  return useSessionStore.getState().messages[0]?.toolCalls?.[0]
}

describe('desktop tool result images', () => {
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

  it('splits a content-part result into copyable text and image URLs', () => {
    startToolCall()
    resolveToolCall([
      { type: 'text', text: '截图已保存' },
      { type: 'image_url', imageUrl: { url: SCREENSHOT_URL } },
      { type: 'image_url', imageUrl: { url: SECOND_URL } },
    ])

    const toolCall = lastToolCall()
    expect(toolCall).toMatchObject({
      status: 'completed',
      result: '截图已保存',
      resultImages: [SCREENSHOT_URL, SECOND_URL],
    })
    // The base64 payload must never end up in the text a user copies.
    expect(toolCall?.result).not.toContain('base64')
  })

  it('keeps an image-only result readable instead of leaving the card body empty', () => {
    startToolCall()
    resolveToolCall([{ type: 'image_url', imageUrl: { url: SCREENSHOT_URL } }])

    const toolCall = lastToolCall()
    expect(toolCall?.resultImages).toEqual([SCREENSHOT_URL])
    expect(toolCall?.result).not.toBe('')
    expect(toolCall?.result).not.toContain('data:')
  })

  it('passes a plain string output through unchanged', () => {
    startToolCall()
    resolveToolCall('command finished')

    const toolCall = lastToolCall()
    expect(toolCall).toMatchObject({ status: 'completed', result: 'command finished' })
    expect(toolCall?.resultImages).toBeUndefined()
  })

  it('keeps the JSON fallback for structured outputs that are not content parts', () => {
    startToolCall()
    resolveToolCall({ bytesWritten: 10 })

    const toolCall = lastToolCall()
    expect(toolCall?.resultImages).toBeUndefined()
    expect(JSON.parse(toolCall?.result ?? '')).toEqual({ bytesWritten: 10 })
  })
})
