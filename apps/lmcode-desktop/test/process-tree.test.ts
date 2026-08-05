import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { terminateChildProcessTree } from '../src/main/process-tree'
import type { TerminableChildProcess } from '../src/main/process-tree'

function fakeChild(): TerminableChildProcess & { stdinEnded: () => boolean } {
  let stdinEnded = false
  return {
    exitCode: null,
    pid: 4242,
    signalCode: null,
    stdin: {
      end: () => {
        stdinEnded = true
      },
    },
    kill: () => {
      throw new Error('direct child kill should not be used by the injected tree signal')
    },
    stdinEnded: () => stdinEnded,
  }
}

describe('child process tree termination', () => {
  it('ends stdin and awaits a graceful tree exit before resolving', async () => {
    const child = fakeChild()
    const exit = Promise.withResolvers<void>()
    const signals: boolean[] = []
    await terminateChildProcessTree(child, exit.promise, {
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 50,
      signalTree: async (_child, force) => {
        signals.push(force)
        queueMicrotask(exit.resolve)
        return true
      },
    })

    expect(child.stdinEnded()).toBe(true)
    expect(signals).toEqual([false])
  })

  it('escalates to force termination for a non-responsive tree and still awaits it', async () => {
    const child = fakeChild()
    const exit = Promise.withResolvers<void>()
    const signals: boolean[] = []
    await terminateChildProcessTree(child, exit.promise, {
      gracefulTimeoutMs: 5,
      forceTimeoutMs: 50,
      signalTree: async (_child, force) => {
        signals.push(force)
        if (force) queueMicrotask(exit.resolve)
        return true
      },
    })

    expect(signals).toEqual([false, true])
  })

  it('rejects instead of silently returning while a process remains alive', async () => {
    const child = fakeChild()
    const neverExits = new Promise<void>(() => {})
    await expect(
      terminateChildProcessTree(child, neverExits, {
        gracefulTimeoutMs: 5,
        forceTimeoutMs: 5,
        signalTree: async () => true,
      }),
    ).rejects.toThrow('did not exit after force termination')
  })

  it('does not signal an already exited child again', async () => {
    const child = fakeChild()
    const exited: TerminableChildProcess = { ...child, exitCode: 0 }
    let signals = 0
    await terminateChildProcessTree(exited, Promise.resolve(), {
      signalTree: async () => {
        signals += 1
        return true
      },
    })
    expect(signals).toBe(0)
  })
})

// ── Windows dynamic verification ────────────────────────────────────────

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function firstLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      cleanup()
      resolve(buffer.slice(0, newline).trim())
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      stream.off('data', onData)
      stream.off('error', onError)
    }
    stream.on('data', onData)
    stream.on('error', onError)
  })
}

describe('windows process tree termination', () => {
  const trackedPids: number[] = []

  afterEach(() => {
    for (const pid of trackedPids.splice(0)) {
      if (!processExists(pid)) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The helper already removed it.
      }
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'removes a spawned descendant and waits for the parent close',
    async () => {
      const grandchildProgram = 'setInterval(() => {}, 1000)'
      const parentProgram = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true });`,
        'console.log(child.pid);',
        'setInterval(() => {}, 1000);',
      ].join('\n')
      const parent = spawn(process.execPath, ['-e', parentProgram], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
      if (parent.pid !== undefined) trackedPids.push(parent.pid)
      const closed = new Promise<void>((resolve) => parent.once('close', () => resolve()))
      const grandchildPid = Number(await firstLine(parent.stdout))
      trackedPids.push(grandchildPid)
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(processExists(grandchildPid)).toBe(true)

      await terminateChildProcessTree(parent, closed, {
        gracefulTimeoutMs: 500,
        forceTimeoutMs: 2_500,
      })

      expect(parent.pid === undefined || !processExists(parent.pid)).toBe(true)
      expect(processExists(grandchildPid)).toBe(false)
    },
  )
})
