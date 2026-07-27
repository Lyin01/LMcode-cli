import { describe, expect, it, vi } from 'vitest'
import { onceAsync, ShutdownCoordinator, withTimeoutBudget } from '../src/main/lifecycle'

describe('desktop shutdown lifecycle', () => {
  it('runs a shared async closer only once for concurrent callers', async () => {
    const deferred = Promise.withResolvers<void>()
    const closeHarness = vi.fn(() => deferred.promise)
    const closeOnce = onceAsync(closeHarness)

    const first = closeOnce()
    const second = closeOnce()
    expect(first).toBe(second)
    expect(closeHarness).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(closeHarness).toHaveBeenCalledOnce()
    deferred.resolve()
    await Promise.all([first, second])
    expect(closeHarness).toHaveBeenCalledOnce()
  })

  it('blocks every quit attempt until cleanup settles, then allows exactly one retry', async () => {
    const deferred = Promise.withResolvers<void>()
    const cleanup = vi.fn(() => deferred.promise)
    const requestQuit = vi.fn()
    const reportError = vi.fn()
    const coordinator = new ShutdownCoordinator(cleanup, requestQuit, reportError)
    const firstEvent = { preventDefault: vi.fn() }
    const secondEvent = { preventDefault: vi.fn() }

    coordinator.handleBeforeQuit(firstEvent)
    coordinator.handleBeforeQuit(secondEvent)
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(requestQuit).not.toHaveBeenCalled()

    deferred.resolve()
    await coordinator.waitForCleanup()
    expect(requestQuit).toHaveBeenCalledOnce()
    expect(reportError).not.toHaveBeenCalled()

    const allowedEvent = { preventDefault: vi.fn() }
    coordinator.handleBeforeQuit(allowedEvent)
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reports cleanup failure but still releases the Electron quit barrier', async () => {
    const error = new Error('harness close failed')
    const requestQuit = vi.fn()
    const reportError = vi.fn()
    const coordinator = new ShutdownCoordinator(
      async () => Promise.reject(error),
      requestQuit,
      reportError,
    )
    const event = { preventDefault: vi.fn() }

    coordinator.handleBeforeQuit(event)
    await coordinator.waitForCleanup()

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith(error)
    expect(requestQuit).toHaveBeenCalledOnce()
  })

  it('resolves "completed" when the work settles within the budget', async () => {
    const deferred = Promise.withResolvers<void>()
    const outcome = withTimeoutBudget(deferred.promise, 1_000)

    deferred.resolve()
    await expect(outcome).resolves.toBe('completed')
  })

  it('resolves "budget-exceeded" when the work outlives the budget', async () => {
    const never = new Promise<void>(() => {})
    const outcome = withTimeoutBudget(never, 50)

    await expect(outcome).resolves.toBe('budget-exceeded')
  })

  it('resolves "completed" for rejected work without leaking an unhandled rejection', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const outcome = withTimeoutBudget(Promise.reject(new Error('close failed')), 1_000)

      await expect(outcome).resolves.toBe('completed')
      // Give the rejection a chance to surface if the budget helper dropped it.
      await new Promise((resolve) => setImmediate(resolve))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
