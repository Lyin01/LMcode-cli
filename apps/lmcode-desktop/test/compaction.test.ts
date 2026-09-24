import { describe, expect, it, vi } from 'vitest'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import {
  COMPACTION_FAILURE_GRACE_MS,
  compactSessionAndWait,
} from '../src/main/compaction'

type SessionListener = (event: Event) => void

/**
 * Minimal stand-in for an SDK session: `compact()` only acknowledges the
 * *begin* of a compaction (agent-core starts a worker and returns), and the
 * real outcome arrives later on the event stream.
 */
function createWatchSession(
  compact: (options: { readonly instruction?: string }) => Promise<void> = async () => undefined,
) {
  const listeners = new Set<SessionListener>()
  const session = {
    compact: vi.fn(compact),
    onEvent: vi.fn((listener: SessionListener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
  }
  const emit = (event: { readonly type: string } & Record<string, unknown>): void => {
    for (const listener of Array.from(listeners)) {
      listener({ agentId: 'main', sessionId: 'session-1', ...event } as unknown as Event)
    }
  }
  return { session, emit, listenerCount: (): number => listeners.size }
}

describe('manual compaction wait', () => {
  it('only settles once the session reports the real completion', async () => {
    const { session, emit } = createWatchSession()
    let settled = false
    const pending = compactSessionAndWait(session, 'retain decisions').then((outcome) => {
      settled = true
      return outcome
    })

    // The begin-ack resolves immediately; that is what used to be reported as
    // "已完成" while the summarization call was still running.
    expect(session.compact).toHaveBeenCalledWith({ instruction: 'retain decisions' })
    await Promise.resolve()
    expect(settled).toBe(false)

    emit({ type: 'compaction.started', trigger: 'manual', instruction: 'retain decisions' })
    emit({ type: 'tool.result', toolCallId: 'tool-1', output: [], isError: false })
    await Promise.resolve()
    expect(settled).toBe(false)

    emit({
      type: 'compaction.completed',
      result: { summary: 'summary', compactedCount: 4, tokensBefore: 120, tokensAfter: 30 },
    })
    await expect(pending).resolves.toEqual({
      outcome: 'completed',
      compactedCount: 4,
      tokensBefore: 120,
      tokensAfter: 30,
      elapsedMs: expect.any(Number),
    })
    expect(settled).toBe(true)
  })

  it('reports a real cancellation with its reason and stops listening', async () => {
    const { session, emit, listenerCount } = createWatchSession()
    const pending = compactSessionAndWait(session, undefined)

    emit({
      type: 'compaction.cancelled',
      reason: '压缩超时（300秒），已取消。请使用 /compact 手动重试。',
    })

    await expect(pending).resolves.toMatchObject({
      outcome: 'cancelled',
      reason: '压缩超时（300秒），已取消。请使用 /compact 手动重试。',
    })
    expect(listenerCount()).toBe(0)
  })

  it('prefers the failure event that follows a reasonless cancellation', async () => {
    const { session, emit, listenerCount } = createWatchSession()
    let settled = false
    const pending = compactSessionAndWait(session, undefined).then((outcome) => {
      settled = true
      return outcome
    })

    // A failed compaction emits `compaction.cancelled` (no reason) immediately
    // before its COMPACTION_FAILED error; the wait must not mistake it for a
    // user cancellation.
    emit({ type: 'compaction.cancelled' })
    await Promise.resolve()
    expect(settled).toBe(false)

    emit({
      type: 'error',
      code: 'compaction.failed',
      message: 'compaction exploded',
      name: 'Error',
      retryable: false,
    })
    await expect(pending).resolves.toMatchObject({
      outcome: 'failed',
      message: 'compaction exploded',
    })
    expect(listenerCount()).toBe(0)
  })

  it('falls back to a bare cancellation when no failure follows', async () => {
    vi.useFakeTimers()
    try {
      const { session, emit, listenerCount } = createWatchSession()
      let settled = false
      const pending = compactSessionAndWait(session, undefined).then((outcome) => {
        settled = true
        return outcome
      })

      emit({ type: 'compaction.cancelled' })
      await vi.advanceTimersByTimeAsync(COMPACTION_FAILURE_GRACE_MS - 1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ outcome: 'cancelled' })
      const outcome = await pending
      expect(outcome).not.toHaveProperty('reason')
      expect(listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a rejected begin and stops watching', async () => {
    const { session, listenerCount } = createWatchSession(async () => {
      throw new Error('No prefix that can be compacted in current history.')
    })

    await expect(compactSessionAndWait(session, undefined)).rejects.toThrow(
      'No prefix that can be compacted',
    )
    expect(listenerCount()).toBe(0)
  })

  it('gives up as pending when no terminal event ever arrives', async () => {
    vi.useFakeTimers()
    try {
      const { session, listenerCount } = createWatchSession()
      let settled = false
      const pending = compactSessionAndWait(session, undefined, { timeoutMs: 1_000 }).then(
        (outcome) => {
          settled = true
          return outcome
        },
      )

      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ outcome: 'pending' })
      expect(listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
