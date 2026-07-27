import { describe, expect, it } from 'vitest'
import {
  buildStallNotice,
  runningToolName,
  STALL_THRESHOLD_MS,
} from '../src/renderer/lib/stream-stall'
import type { Message } from '../src/renderer/types'

function assistantMessage(toolCalls?: Message['toolCalls']): Message {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls }
}

describe('runningToolName', () => {
  it('returns the running tool of the latest assistant message', () => {
    const messages = [
      assistantMessage([
        { id: 't1', toolName: 'Write', args: '', status: 'completed' },
        { id: 't2', toolName: 'Bash', args: '', status: 'running' },
      ]),
    ]
    expect(runningToolName(messages)).toBe('Bash')
  })

  it('returns null when no tool is running or no assistant message exists', () => {
    expect(runningToolName([assistantMessage([
      { id: 't1', toolName: 'Write', args: '', status: 'completed' },
    ])])).toBeNull()
    expect(runningToolName([])).toBeNull()
    expect(runningToolName([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    ])).toBeNull()
  })
})

describe('buildStallNotice', () => {
  it('names the executing tool with elapsed seconds', () => {
    expect(buildStallNotice('Write', 45_000)).toContain('Write 仍在执行')
    expect(buildStallNotice('Write', 45_000)).toContain('45 秒')
  })

  it('falls back to a model-wait notice without a running tool', () => {
    expect(buildStallNotice(null, 12_500)).toBe('仍在等待模型响应…（已 12 秒）')
  })
})

describe('STALL_THRESHOLD_MS', () => {
  it('is a human-scale heartbeat delay', () => {
    expect(STALL_THRESHOLD_MS).toBeGreaterThanOrEqual(5_000)
    expect(STALL_THRESHOLD_MS).toBeLessThanOrEqual(30_000)
  })
})
