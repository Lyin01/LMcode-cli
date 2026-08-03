import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StallIndicator } from '@/components/StallIndicator'
import * as sessionStoreModule from '@/stores/session-store'
import type { SessionStore } from '@/stores/session-store'
import {
  buildStallNotice,
  runningToolName,
  STALL_THRESHOLD_MS,
} from '../src/renderer/lib/stream-stall'
import type { Message } from '../src/renderer/types'

/**
 * Renders the indicator against a mocked store and records every selector
 * result, so the test can tell which store slices the component subscribes to.
 */
function captureStallIndicatorSelectors(state: SessionStore): unknown[] {
  const captured: unknown[] = []
  vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(
    ((selector: (store: SessionStore) => unknown) => {
      const value = selector(state)
      captured.push(value)
      return value
    }) as typeof sessionStoreModule.useSessionStore,
  )
  renderToStaticMarkup(createElement(StallIndicator))
  vi.restoreAllMocks()
  return captured
}

describe('StallIndicator stall-clock subscription', () => {
  it('subscribes to streamStatus so retry/interrupted updates reset the clock', () => {
    const base = {
      ...sessionStoreModule.useSessionStore.getState(),
      currentSessionId: 'session-a',
      messages: [],
      isStreaming: true,
      streamStatus: null,
    }
    const idle = captureStallIndicatorSelectors(base)
    const retrying = captureStallIndicatorSelectors({
      ...base,
      streamStatus: '网络/模型异常，正在重试（1/3）…',
    })

    // Retry/backoff transitions only touch streamStatus — the component must
    // observe that slice, otherwise the stall clock keeps accumulating.
    expect(retrying.length).toBe(idle.length)
    expect(retrying.some((value, index) => value !== idle[index])).toBe(true)
  })
})

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
