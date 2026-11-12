import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IDLE_SESSION_TTL_MS,
  IdleSessionReaper,
  type ReapCandidate,
} from '../src/main/session-reaper'

const TTL = 30 * 60_000
const NOW = 10 * TTL

function candidate(sessionId: string, lastActivityAt: number): ReapCandidate {
  return { sessionId, lastActivityAt }
}

describe('IdleSessionReaper', () => {
  it('reclaims expired sessions oldest first and never the most recent one', async () => {
    const reclaimed: string[] = []
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [
          candidate('oldest', NOW - 90 * 60_000),
          candidate('middle', NOW - 45 * 60_000),
          candidate('fresh', NOW - 60_000),
          candidate('most-recent', NOW),
        ],
        canReclaim: async () => true,
        reclaim: async (sessionId) => {
          reclaimed.push(sessionId)
        },
      },
      { now: () => NOW },
    )

    await reaper.runOnce()

    expect(reclaimed).toEqual(['oldest', 'middle'])
  })

  it('treats exactly-at-TTL as expired', async () => {
    const reclaimed: string[] = []
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [candidate('edge', NOW - TTL), candidate('keeper', NOW)],
        canReclaim: async () => true,
        reclaim: async (sessionId) => {
          reclaimed.push(sessionId)
        },
      },
      { now: () => NOW },
    )

    await reaper.runOnce()

    expect(reclaimed).toEqual(['edge'])
  })

  it('honours the canReclaim veto with the session id', async () => {
    const reclaimed: string[] = []
    const canReclaim = vi.fn(async (sessionId: string) => sessionId !== 'vetoed')
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [
          candidate('vetoed', NOW - 3 * TTL),
          candidate('ok', NOW - 2 * TTL),
          candidate('keeper', NOW),
        ],
        canReclaim,
        reclaim: async (sessionId) => {
          reclaimed.push(sessionId)
        },
      },
      { now: () => NOW },
    )

    await reaper.runOnce()

    expect(canReclaim).toHaveBeenCalledWith('vetoed')
    expect(reclaimed).toEqual(['ok'])
  })

  it('keeps scanning after a failed reclaim and reports it', async () => {
    const reclaimed: string[] = []
    const logWarn = vi.fn()
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [
          candidate('broken', NOW - 3 * TTL),
          candidate('recoverable', NOW - 2 * TTL),
          candidate('keeper', NOW),
        ],
        canReclaim: async () => true,
        reclaim: async (sessionId) => {
          if (sessionId === 'broken') throw new Error('close failed')
          reclaimed.push(sessionId)
        },
      },
      { now: () => NOW, logWarn },
    )

    await reaper.runOnce()

    expect(reclaimed).toEqual(['recoverable'])
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('runs a single scan when called concurrently', async () => {
    const hold = Promise.withResolvers<void>()
    const listCandidates = vi.fn(() => [
      candidate('idle', NOW - 3 * TTL),
      candidate('keeper', NOW),
    ])
    const reaper = new IdleSessionReaper(
      {
        listCandidates,
        canReclaim: async () => {
          await hold.promise
          return true
        },
        reclaim: async () => {},
      },
      { now: () => NOW },
    )

    const first = reaper.runOnce()
    const second = reaper.runOnce()
    expect(second).toBe(first)
    hold.resolve()
    await Promise.all([first, second])
    expect(listCandidates).toHaveBeenCalledTimes(1)
  })

  it('scans on the configured interval and stops cleanly', async () => {
    let scheduled: () => void = () => {}
    const handle = { unref: vi.fn() }
    const setIntervalFn = vi.fn((callback: () => void) => {
      scheduled = callback
      return handle as unknown as NodeJS.Timeout
    })
    const clearIntervalFn = vi.fn()
    const reclaimed: string[] = []
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [candidate('idle', NOW - 3 * TTL), candidate('keeper', NOW)],
        canReclaim: async () => true,
        reclaim: async (sessionId) => {
          reclaimed.push(sessionId)
        },
      },
      { now: () => NOW, setIntervalFn, clearIntervalFn, scanIntervalMs: 5_000 },
    )

    reaper.start()
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5_000)
    expect(handle.unref).toHaveBeenCalled()

    scheduled()
    await reaper.runOnce()
    expect(reclaimed).toEqual(['idle'])

    reaper.stop()
    expect(clearIntervalFn).toHaveBeenCalledTimes(1)

    // After stop, scans are inert.
    await reaper.runOnce()
    expect(reclaimed).toEqual(['idle'])
  })

  it('tolerates an empty candidate list', async () => {
    const reaper = new IdleSessionReaper(
      {
        listCandidates: () => [],
        canReclaim: async () => true,
        reclaim: async () => {},
      },
      { now: () => NOW },
    )

    await expect(reaper.runOnce()).resolves.toBeUndefined()
  })

  it('exposes the default TTL constant', () => {
    expect(DEFAULT_IDLE_SESSION_TTL_MS).toBe(30 * 60_000)
  })
})
