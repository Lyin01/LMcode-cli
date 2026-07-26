import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectTerminalManager } from '../src/main/project-terminal'
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
      { timeout: 5_000 },
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
