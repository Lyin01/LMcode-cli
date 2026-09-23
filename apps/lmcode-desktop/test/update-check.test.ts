import { describe, expect, it, vi } from 'vitest'
import { UPDATE_CHECK_ROUND_TIMEOUT_MS, UpdateCheckCoordinator } from '../src/main/update-check'

describe('UpdateCheckCoordinator', () => {
  it('tracks the manual attribute of the in-flight check round', () => {
    const start = vi.fn(() => Promise.resolve())
    const coordinator = new UpdateCheckCoordinator(start)

    expect(coordinator.isManual).toBe(false)
    coordinator.check(false)
    expect(start).toHaveBeenCalledTimes(1)
    expect(coordinator.isManual).toBe(false)
  })

  it('upgrades an in-flight background check when a manual check is requested', () => {
    const pending = Promise.withResolvers<void>()
    const start = vi.fn(() => pending.promise)
    const coordinator = new UpdateCheckCoordinator(start)

    coordinator.check(false)
    coordinator.check(true)

    // No second electron-updater round-trip; the in-flight round now reports.
    expect(start).toHaveBeenCalledTimes(1)
    expect(coordinator.isManual).toBe(true)
  })

  it('keeps an in-flight manual check manual when a background check follows', async () => {
    const pending = Promise.withResolvers<void>()
    const start = vi.fn(() => pending.promise)
    const coordinator = new UpdateCheckCoordinator(start)

    coordinator.check(true)
    coordinator.check(false)
    expect(start).toHaveBeenCalledTimes(1)
    expect(coordinator.isManual).toBe(true)

    pending.resolve()
    await vi.waitFor(() => {
      expect(coordinator.isManual).toBe(false)
    })
  })

  it('does not leak the manual flag into checks started after the manual one settles', async () => {
    const start = vi.fn(() => Promise.resolve())
    const coordinator = new UpdateCheckCoordinator(start)

    coordinator.check(true)
    expect(coordinator.isManual).toBe(true)
    await vi.waitFor(() => {
      expect(coordinator.isManual).toBe(false)
    })

    coordinator.check(false)
    expect(start).toHaveBeenCalledTimes(2)
    expect(coordinator.isManual).toBe(false)
  })

  it('recovers after a failed check so later checks still run', async () => {
    const start = vi.fn(() => Promise.reject(new Error('network down')))
    const coordinator = new UpdateCheckCoordinator(start)

    coordinator.check(true)
    await vi.waitFor(() => {
      expect(coordinator.isManual).toBe(false)
    })

    coordinator.check(false)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('starts a new round after a check that never settles is abandoned', async () => {
    vi.useFakeTimers()
    try {
      const stuck = Promise.withResolvers<void>()
      const start = vi.fn<() => Promise<unknown>>()
        .mockReturnValueOnce(stuck.promise)
        .mockResolvedValue(undefined)
      const coordinator = new UpdateCheckCoordinator(start)

      coordinator.check(false)
      coordinator.check(true)
      expect(start).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_ROUND_TIMEOUT_MS)

      // The wedged round stops shadowing the feature ...
      expect(coordinator.isManual).toBe(false)

      // ... so a manual click reaches electron-updater again, as a manual round.
      coordinator.check(true)
      expect(start).toHaveBeenCalledTimes(2)
      expect(coordinator.isManual).toBe(true)

      await vi.advanceTimersByTimeAsync(0)
      expect(coordinator.isManual).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not abandon the round that replaced a settled one', async () => {
    vi.useFakeTimers()
    try {
      const first = Promise.withResolvers<void>()
      const second = Promise.withResolvers<void>()
      const start = vi.fn<() => Promise<unknown>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const coordinator = new UpdateCheckCoordinator(start)

      coordinator.check(false)
      first.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(coordinator.isManual).toBe(false)

      // A new round starts halfway into the settled round's watchdog window.
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_ROUND_TIMEOUT_MS / 2)
      coordinator.check(true)
      expect(start).toHaveBeenCalledTimes(2)

      // Reaching the settled round's deadline must not release the new one.
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_ROUND_TIMEOUT_MS / 2)
      expect(coordinator.isManual).toBe(true)
      coordinator.check(false)
      expect(start).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
