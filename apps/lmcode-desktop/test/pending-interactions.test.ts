import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingInteractionRegistry } from '../src/main/ipc/pending-interactions'

describe('PendingInteractionRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles concurrent requests independently without dropping either resolver', () => {
    const registry = new PendingInteractionRegistry<string>()
    const first = vi.fn()
    const second = vi.fn()
    registry.add('first', 'session-a', first)
    registry.add('second', 'session-b', second)

    expect(registry.settle('second', 'B')).toBe(true)
    expect(second).toHaveBeenCalledWith('B')
    expect(first).not.toHaveBeenCalled()
    expect(registry.size).toBe(1)

    expect(registry.settle('first', 'A')).toBe(true)
    expect(first).toHaveBeenCalledWith('A')
    expect(registry.size).toBe(0)
    expect(registry.settle('first', 'again')).toBe(false)
  })

  it('cancels requests by session and then resolves every remaining request', () => {
    const registry = new PendingInteractionRegistry<null>()
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    registry.add('first', 'session-a', first)
    registry.add('second', 'session-a', second)
    registry.add('third', 'session-b', third)

    expect(registry.settleSession('session-a', null)).toBe(2)
    expect(first).toHaveBeenCalledWith(null)
    expect(second).toHaveBeenCalledWith(null)
    expect(third).not.toHaveBeenCalled()

    expect(registry.settleAll(null)).toBe(1)
    expect(third).toHaveBeenCalledWith(null)
    expect(registry.size).toBe(0)
  })

  it('expires a request and runs final cleanup exactly once', async () => {
    vi.useFakeTimers()
    const registry = new PendingInteractionRegistry<string>()
    const onSettled = vi.fn()
    const request = registry.request('approval-1', 'session-a', {
      timeoutMs: 100,
      timeoutValue: 'cancelled',
      onSettled,
    })

    await vi.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toBe('cancelled')
    expect(registry.size).toBe(0)
    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith('approval-1', 'session-a')
  })

  it('keeps timeout and concurrent session cancellation idempotent', async () => {
    vi.useFakeTimers()
    const registry = new PendingInteractionRegistry<string>()
    const onSettled = vi.fn()
    const request = registry.request('question-1', 'session-a', {
      timeoutMs: 100,
      timeoutValue: 'timed-out',
      onSettled,
    })

    expect(registry.settleSession('session-a', 'cancelled')).toBe(1)
    expect(registry.settle('question-1', 'late-response')).toBe(false)
    await vi.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toBe('cancelled')
    expect(registry.size).toBe(0)
    expect(onSettled).toHaveBeenCalledOnce()
  })
})
