import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectTerminalManager,
  TerminalOutputBatcher,
  TERMINAL_OUTPUT_TRUNCATED_NOTICE,
} from '../src/main/project-terminal'
import { normalizeTerminalText } from '../src/renderer/lib/terminal-text'
import type { TerminalOutputPayload } from '../src/shared/terminal-types'

let terminalManager: ProjectTerminalManager | undefined

afterEach(async () => {
  await terminalManager?.close()
  terminalManager = undefined
})

describe('desktop project terminal', () => {
  it('runs user commands in the selected project and streams their output', async () => {
    const output: TerminalOutputPayload[] = []
    terminalManager = new ProjectTerminalManager((payload) => output.push(payload))
    const info = terminalManager.start('session-terminal', process.cwd())

    terminalManager.write(
      'session-terminal',
      `node -e "process.stdout.write('lmcode-terminal-ok')"\n`,
    )

    await vi.waitFor(
      () => {
        expect(output.map((payload) => payload.data).join('')).toContain('lmcode-terminal-ok')
      },
      { timeout: 15_000 },
    )
    expect(info).toEqual(
      expect.objectContaining({
        sessionId: 'session-terminal',
        workDir: process.cwd(),
        running: true,
      }),
    )
  })

  it('removes terminal control sequences before rendering output', () => {
    expect(normalizeTerminalText('\u001b[31merror\u001b[0m\r\nnext\titem\u0000')).toBe(
      'error\nnext    item',
    )
  })
})

describe('terminal output batcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function createBatcher(options: { flushIntervalMs: number; bufferLimitChars: number }) {
    const emitted: { stream: string; data: string }[] = []
    const batcher = new TerminalOutputBatcher(
      (stream, data) => emitted.push({ stream, data }),
      options,
    )
    return { emitted, batcher }
  }

  it('coalesces rapid chunks into one throttled batch per stream', () => {
    vi.useFakeTimers()
    const { emitted, batcher } = createBatcher({ flushIntervalMs: 16, bufferLimitChars: 1024 })

    batcher.push('stdout', 'chunk-1')
    batcher.push('stderr', 'err-1')
    batcher.push('stdout', Buffer.from('chunk-2'))
    expect(emitted).toEqual([])

    vi.advanceTimersByTime(16)
    expect(emitted).toEqual([
      { stream: 'stdout', data: 'chunk-1chunk-2' },
      { stream: 'stderr', data: 'err-1' },
    ])
    batcher.dispose()
  })

  it('drops the oldest buffered output beyond the cap and flags the truncation', () => {
    vi.useFakeTimers()
    const { emitted, batcher } = createBatcher({ flushIntervalMs: 16, bufferLimitChars: 8 })

    batcher.push('stdout', '0123456789')
    vi.advanceTimersByTime(16)

    expect(emitted).toEqual([
      { stream: 'stdout', data: '23456789' },
      { stream: 'system', data: TERMINAL_OUTPUT_TRUNCATED_NOTICE },
    ])
    batcher.dispose()
  })

  it('flush() emits pending output immediately and cancels the scheduled batch', () => {
    vi.useFakeTimers()
    const { emitted, batcher } = createBatcher({ flushIntervalMs: 16, bufferLimitChars: 1024 })

    batcher.push('stdout', 'pending')
    batcher.flush()
    expect(emitted).toEqual([{ stream: 'stdout', data: 'pending' }])

    vi.advanceTimersByTime(60_000)
    expect(emitted).toHaveLength(1)
    batcher.dispose()
  })
})
