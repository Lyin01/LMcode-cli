import { describe, expect, it } from 'vitest'
import { deriveRunStatus, formatRunElapsed } from '../src/renderer/lib/run-status'
import type { Message } from '../src/renderer/types'

function assistant(overrides: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 1_000,
    thinkingState: 'streaming',
    ...overrides,
  }
}

const baseInput = {
  isStreaming: true,
  streamStatus: null,
  thinkingEffort: 'medium' as const,
  now: 6_500,
}

describe('run status projection', () => {
  it('exposes automatic review progress as a bounded phase', () => {
    const status = deriveRunStatus({
      ...baseInput,
      messages: [
        assistant({
          toolCalls: [
            {
              id: 'write-1',
              toolName: 'Write',
              args: '{}',
              status: 'running',
              progress: 'Automatic review 1/2: inspecting rendered keyframes',
            },
          ],
        }),
      ],
    })

    expect(status).toMatchObject({
      phase: 'reviewing',
      label: '自动审查 · 渲染检查',
      review: { current: 1, total: 2 },
      elapsedMs: 5_500,
    })
  })

  it('does not mislabel ongoing work as finishing after the review limit is reached', () => {
    const status = deriveRunStatus({
      ...baseInput,
      messages: [
        assistant({
          content: '已完成。',
          thinkingState: 'complete',
          toolCalls: [
            {
              id: 'write-2',
              toolName: 'Write',
              args: '{}',
              status: 'completed',
              result: 'Automatic post-write review was skipped because this turn reached its 2-review limit.',
            },
          ],
        }),
      ],
    })

    expect(status).toMatchObject({
      phase: 'responding',
      label: '正在整理回答',
    })
  })

  it('formats elapsed time for compact activity labels', () => {
    expect(formatRunElapsed(0)).toBe('0s')
    expect(formatRunElapsed(59_999)).toBe('59s')
    expect(formatRunElapsed(60_000)).toBe('1m 00s')
    expect(formatRunElapsed(125_000)).toBe('2m 05s')
  })
})
