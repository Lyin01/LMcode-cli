import { describe, expect, it } from 'vitest'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import {
  appendUserItem,
  createTranscript,
  historyToTranscript,
  reduceTranscript,
} from '../src/remote-app/transcript'

function ev(payload: Record<string, unknown>): Event {
  return payload as unknown as Event
}

describe('reduceTranscript', () => {
  it('accumulates assistant text and thinking into one bubble and tracks the turn', () => {
    let state = createTranscript()
    state = reduceTranscript(state, ev({ type: 'turn.started', turnId: 1 }))
    expect(state.running).toBe(true)

    state = reduceTranscript(state, ev({ type: 'assistant.delta', turnId: 1, delta: '你好' }))
    state = reduceTranscript(state, ev({ type: 'thinking.delta', turnId: 1, delta: '推理中' }))
    state = reduceTranscript(state, ev({ type: 'assistant.delta', turnId: 1, delta: '，世界' }))

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'assistant',
      text: '你好，世界',
      thinking: '推理中',
    })

    state = reduceTranscript(state, ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }))
    expect(state.running).toBe(false)
  })

  it('attaches tool results to the matching call and marks failures', () => {
    let state = createTranscript()
    state = reduceTranscript(
      state,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 't1', name: 'Bash', args: {} }),
    )
    expect(state.items[0]).toMatchObject({ kind: 'tool', name: 'Bash', status: 'running' })

    state = reduceTranscript(
      state,
      ev({ type: 'tool.result', turnId: 1, toolCallId: 't1', output: 'boom', isError: true }),
    )
    expect(state.items[0]).toMatchObject({ kind: 'tool', status: 'error', detail: 'boom' })
  })

  it('surfaces errors (event and failed turn) as notices', () => {
    let state = reduceTranscript(createTranscript(), ev({ type: 'turn.started', turnId: 1 }))
    state = reduceTranscript(
      state,
      ev({ type: 'error', code: 'provider_error', message: '连接模型失败', retryable: true }),
    )
    state = reduceTranscript(
      state,
      ev({ type: 'turn.ended', turnId: 1, reason: 'failed', error: { message: '中断' } }),
    )
    expect(state.running).toBe(false)
    expect(state.items.map((item) => item.kind)).toEqual(['notice', 'notice'])
    expect(state.items[0]).toMatchObject({ kind: 'notice', level: 'error', text: '连接模型失败' })
  })

  it('appends optimistic user messages without disturbing running state', () => {
    const state = appendUserItem(createTranscript(), '你好')
    expect(state.items).toEqual([expect.objectContaining({ kind: 'user', text: '你好' })])
    expect(state.running).toBe(false)
  })
})

describe('historyToTranscript', () => {
  it('maps user/assistant/tool turns, skips injected reminders and attaches results', () => {
    const state = historyToTranscript([
      { role: 'user', content: [{ type: 'text', text: '真实提问' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: '系统注入' }],
        origin: { kind: 'system_trigger' },
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '回答' },
          { type: 'think', think: '推理' },
        ],
        toolCalls: [{ id: 'call-1', name: 'Read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容' }] },
    ])

    expect(state.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(state.items[0]).toMatchObject({ kind: 'user', text: '真实提问' })
    expect(state.items[1]).toMatchObject({ kind: 'assistant', text: '回答', thinking: '推理' })
    expect(state.items[2]).toMatchObject({
      kind: 'tool',
      name: 'Read',
      status: 'done',
      detail: '文件内容',
    })
  })
})
