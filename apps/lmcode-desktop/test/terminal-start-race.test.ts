import { describe, expect, it, vi } from 'vitest'
import { createLatestRequestGate } from '../src/renderer/lib/latest-request'
import { launchTerminal } from '../src/renderer/lib/terminal-session'
import type { ProjectTerminalInfo } from '../src/shared/terminal-types'

function info(sessionId: string): ProjectTerminalInfo {
  return { sessionId, workDir: `C:/repo/${sessionId}`, shell: 'bash', running: true }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

describe('terminal launch race guard', () => {
  it('adopts the shell when the ticket is still current on resolve', async () => {
    const gate = createLatestRequestGate()
    const stopTerminal = vi.fn(() => Promise.resolve())
    const api = { startTerminal: vi.fn(() => Promise.resolve(info('a'))), stopTerminal }

    const result = await launchTerminal(api, gate, gate.begin(), 'a')

    expect(result.adopted).toBe(true)
    expect(result.info?.sessionId).toBe('a')
    expect(stopTerminal).not.toHaveBeenCalled()
  })

  it('reclaims the spawned shell and drops the result when the session switched mid-start', async () => {
    const gate = createLatestRequestGate()
    const start = deferred<ProjectTerminalInfo>()
    const stopTerminal = vi.fn(() => Promise.resolve())
    const api = { startTerminal: vi.fn(() => start.promise), stopTerminal }

    const ticketB = gate.begin()
    const launching = launchTerminal(api, gate, ticketB, 'b')

    // Session switched to C while B's shell was still spawning.
    gate.begin()
    start.resolve(info('b'))

    const result = await launching
    expect(result.adopted).toBe(false)
    expect(result.info).toBeNull()
    // The freshly spawned B shell must not leak in the main process.
    expect(stopTerminal).toHaveBeenCalledTimes(1)
    expect(stopTerminal).toHaveBeenCalledWith('b')
  })

  it('still reports the launch as stale when the best-effort reclaim fails', async () => {
    const gate = createLatestRequestGate()
    const stopTerminal = vi.fn(() => Promise.reject(new Error('no such terminal')))
    const api = { startTerminal: vi.fn(() => Promise.resolve(info('b'))), stopTerminal }

    const ticketB = gate.begin()
    gate.begin()
    const result = await launchTerminal(api, gate, ticketB, 'b')

    expect(result.adopted).toBe(false)
    expect(result.info).toBeNull()
    expect(stopTerminal).toHaveBeenCalledWith('b')
  })

  it('propagates a start failure so the caller can surface or drop it', async () => {
    const gate = createLatestRequestGate()
    const failure = new Error('spawn failed')
    const api = {
      startTerminal: vi.fn(() => Promise.reject(failure)),
      stopTerminal: vi.fn(() => Promise.resolve()),
    }

    await expect(launchTerminal(api, gate, gate.begin(), 'a')).rejects.toBe(failure)
    expect(api.stopTerminal).not.toHaveBeenCalled()
  })
})
