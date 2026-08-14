import { spawn } from 'node:child_process'
import * as path from 'node:path'

/**
 * Minimal structural view of a child process that the terminator needs. Real
 * `ChildProcess` instances satisfy it; tests pass lightweight fakes.
 */
export interface TerminableChildProcess {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdin: { end: () => void } | null
  kill: (signal?: NodeJS.Signals) => boolean
}

export interface TerminateProcessTreeOptions {
  readonly gracefulTimeoutMs?: number
  readonly forceTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  /** Test seam: replace the platform-specific tree signalling entirely. */
  readonly signalTree?: (child: TerminableChildProcess, force: boolean) => Promise<boolean>
  readonly spawnProcess?: typeof spawn
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void
}

interface NormalizedTerminateOptions {
  readonly forceTimeoutMs: number
  readonly gracefulTimeoutMs: number
  readonly killProcess: (pid: number, signal: NodeJS.Signals) => void
  readonly platform: NodeJS.Platform
  readonly signalTree:
    | ((child: TerminableChildProcess, force: boolean) => Promise<boolean>)
    | undefined
  readonly spawnProcess: typeof spawn
}

export function hasExited(child: TerminableChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>()
  const timer: NodeJS.Timeout = setTimeout(() => timeout.resolve(false), timeoutMs)
  try {
    return await Promise.race([exited.then(() => true), timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

export function runTaskkill(
  pid: number,
  force: boolean,
  spawnProcess: typeof spawn = spawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Resolve taskkill.exe from SystemRoot instead of relying on PATH: some
    // minimal environments (CI shells, service accounts) strip System32.
    const taskkillPath = path.join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    )
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    let settled = false
    const settle = (result: boolean): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const killer = spawnProcess(taskkillPath, args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => settle(false))
    killer.once('close', (code) => settle(code === 0))
  })
}

async function signalProcessTree(
  child: TerminableChildProcess,
  force: boolean,
  options: NormalizedTerminateOptions,
): Promise<boolean> {
  if (options.signalTree !== undefined) return options.signalTree(child, force)

  if (options.platform === 'win32') {
    if (typeof child.pid !== 'number') return false
    const killed = await runTaskkill(child.pid, force, options.spawnProcess)
    // When taskkill is blocked by system policy, fall back to a direct
    // SIGKILL on the shell child so at least the parent cannot linger; the
    // awaited close below then surfaces any leftover descendants as an error
    // instead of pretending the stop succeeded.
    if (!killed && force && !hasExited(child)) return child.kill('SIGKILL')
    return killed
  }

  // The terminal was spawned detached, so it leads its own process group:
  // signal the negative PID to reach every descendant at once.
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM'
  if (typeof child.pid === 'number') {
    try {
      options.killProcess(-child.pid, signal)
      return true
    } catch {
      // Fall back to the direct child when a process group is unavailable.
    }
  }
  return child.kill(signal)
}

/**
 * Terminate a terminal child together with its whole process tree and only
 * resolve once the child actually closed. Ends stdin first (shells exit on
 * EOF), then signals gracefully and escalates to a forced kill after the
 * graceful timeout. Rejects when the child is still alive after the forced
 * phase instead of silently returning while a process remains.
 */
export async function terminateChildProcessTree(
  child: TerminableChildProcess,
  exited: Promise<void>,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  const normalized: NormalizedTerminateOptions = {
    forceTimeoutMs: options.forceTimeoutMs ?? 1_500,
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? 1_500,
    killProcess: options.killProcess ?? ((pid, signal) => process.kill(pid, signal)),
    platform: options.platform ?? process.platform,
    signalTree: options.signalTree,
    spawnProcess: options.spawnProcess ?? spawn,
  }

  try {
    child.stdin?.end()
  } catch {
    // A closed stdin is equivalent to the graceful shutdown signal already
    // being delivered.
  }
  if (hasExited(child)) return

  await signalProcessTree(child, false, normalized)
  if (await waitForExit(exited, normalized.gracefulTimeoutMs)) return

  await signalProcessTree(child, true, normalized)
  if (await waitForExit(exited, normalized.forceTimeoutMs)) return
  throw new Error(
    `Terminal process tree ${child.pid ?? 'unknown'} did not exit after force termination`,
  )
}
