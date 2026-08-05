import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import { createSessionEventBatcher } from '../src/renderer/lib/session-event-batcher'

interface ManualScheduler {
  schedule: (callback: () => void) => number
  cancel: (token: unknown) => void
  runAll: () => void
  size: () => number
}

function manualScheduler(): ManualScheduler {
  let nextId = 0
  const callbacks = new Map<number, () => void>()
  return {
    schedule(callback) {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    },
    cancel(token) {
      callbacks.delete(token as number)
    },
    runAll() {
      const current = [...callbacks.values()]
      callbacks.clear()
      for (const callback of current) callback()
    },
    size: () => callbacks.size,
  }
}

function assistantDelta(delta: string, turnId = 1): Event {
  return { type: 'assistant.delta', turnId, delta, agentId: 'main', sessionId: 'session-a' }
}

function thinkingDelta(delta: string, turnId = 1): Event {
  return { type: 'thinking.delta', turnId, delta, agentId: 'main', sessionId: 'session-a' }
}

describe('session event batcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('five thousand assistant deltas become one store dispatch with identical content', () => {
    const scheduler = manualScheduler()
    const dispatched: Array<{ sessionId: string; event: Event }> = []
    const batcher = createSessionEventBatcher(
      (sessionId, event) => dispatched.push({ sessionId, event }),
      scheduler,
    )
    const expected: string[] = []

    for (let index = 0; index < 5000; index += 1) {
      const delta = `${index % 10}`
      expected.push(delta)
      batcher.push('session-a', assistantDelta(delta))
    }

    expect(dispatched).toHaveLength(0)
    expect(scheduler.size()).toBe(1)
    expect(batcher.pendingCount()).toBe(1)
    scheduler.runAll()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.sessionId).toBe('session-a')
    expect(dispatched[0]!.event).toMatchObject({ type: 'assistant.delta', delta: expected.join('') })
  })

  it('assistant and thinking streams preserve segment order across types, turns, and sessions', () => {
    const scheduler = manualScheduler()
    const dispatched: Array<{ sessionId: string; event: Event }> = []
    const batcher = createSessionEventBatcher(
      (sessionId, event) => dispatched.push({ sessionId, event }),
      scheduler,
    )

    batcher.push('session-a', assistantDelta('A', 1))
    batcher.push('session-a', thinkingDelta('T', 1))
    batcher.push('session-a', assistantDelta('B', 1))
    batcher.push('session-a', assistantDelta('C', 2))
    batcher.push('session-b', assistantDelta('D', 1))
    scheduler.runAll()

    expect(
      dispatched.map(({ sessionId, event }) => [
        sessionId,
        event.type,
        (event as { turnId: number }).turnId,
        (event as { delta: string }).delta,
      ]),
    ).toEqual([
      ['session-a', 'assistant.delta', 1, 'A'],
      ['session-a', 'thinking.delta', 1, 'T'],
      ['session-a', 'assistant.delta', 1, 'B'],
      ['session-a', 'assistant.delta', 2, 'C'],
      ['session-b', 'assistant.delta', 1, 'D'],
    ])
  })

  it('a non-delta event synchronously flushes text before preserving event order', () => {
    const scheduler = manualScheduler()
    const dispatched: Event[] = []
    const batcher = createSessionEventBatcher((_sessionId, event) => dispatched.push(event), scheduler)

    batcher.push('session-a', assistantDelta('done'))
    batcher.push('session-a', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      agentId: 'main',
      sessionId: 'session-a',
    })

    expect(dispatched.map((event) => event.type)).toEqual(['assistant.delta', 'turn.ended'])
    expect(dispatched[0]).toMatchObject({ delta: 'done' })
    expect(scheduler.size()).toBe(0)
  })

  it('null and sub-agent ids are barriers: they pass through unbatched and never merge with main', () => {
    const scheduler = manualScheduler()
    const dispatched: Event[] = []
    const batcher = createSessionEventBatcher((_sessionId, event) => dispatched.push(event), scheduler)

    batcher.push('session-a', assistantDelta('A'))
    // agentId: null arrives from some main processes; it must not merge into
    // the main stream (that is how the store's filter treats it too).
    batcher.push('session-a', { ...assistantDelta('X'), agentId: null } as unknown as Event)
    batcher.push('session-a', { ...assistantDelta('W'), agentId: 'worker-1' })
    batcher.push('session-a', assistantDelta('B'))
    scheduler.runAll()

    expect(dispatched.map((event) => [event.type, (event as { delta: string }).delta])).toEqual([
      ['assistant.delta', 'A'],
      ['assistant.delta', 'X'],
      ['assistant.delta', 'W'],
      ['assistant.delta', 'B'],
    ])
  })

  it('events without an agentId (older main processes) merge with the main stream', () => {
    const scheduler = manualScheduler()
    const dispatched: Event[] = []
    const batcher = createSessionEventBatcher((_sessionId, event) => dispatched.push(event), scheduler)

    batcher.push('session-a', assistantDelta('A'))
    batcher.push('session-a', { type: 'assistant.delta', turnId: 1, delta: 'B' } as unknown as Event)
    scheduler.runAll()

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ delta: 'AB' })
  })

  it('dispose flushes pending content exactly once and rejects later events', () => {
    const scheduler = manualScheduler()
    const dispatched: Event[] = []
    const batcher = createSessionEventBatcher((_sessionId, event) => dispatched.push(event), scheduler)

    batcher.push('session-a', assistantDelta('last'))
    batcher.dispose()
    batcher.dispose()
    scheduler.runAll()
    batcher.push('session-a', assistantDelta('ignored'))

    expect(dispatched.map((event) => (event as { delta: string }).delta)).toEqual(['last'])
  })

  it('the default scheduler flushes after a bounded 16ms window', () => {
    vi.useFakeTimers()
    const dispatched: Event[] = []
    const batcher = createSessionEventBatcher((_sessionId, event) => dispatched.push(event))

    batcher.push('session-a', assistantDelta('tick'))
    expect(dispatched).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(dispatched.map((event) => (event as { delta: string }).delta)).toEqual(['tick'])
    batcher.dispose()
  })
})
