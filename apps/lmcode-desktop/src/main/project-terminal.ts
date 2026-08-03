import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  ProjectTerminalInfo,
  TerminalOutputPayload,
  TerminalOutputStream,
} from '../shared/terminal-types.js'

const TERMINAL_INPUT_LIMIT_CHARS = 65_536
const TERMINAL_STOP_TIMEOUT_MS = 1_500
const TERMINAL_OUTPUT_FLUSH_INTERVAL_MS = 16
const TERMINAL_OUTPUT_BUFFER_LIMIT_CHARS = 1024 * 1024
export const TERMINAL_OUTPUT_TRUNCATED_NOTICE =
  '\n[终端输出过快，已丢弃部分最早的内容]\n'

interface ShellCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly label: string
}

interface ProjectTerminalEntry {
  readonly sessionId: string
  readonly workDir: string
  readonly shell: string
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  readonly batcher: TerminalOutputBatcher
}

export interface TerminalOutputBatcherOptions {
  /** Chunks arriving within one interval are merged into a single send. */
  readonly flushIntervalMs: number
  /** Per-session pending cap; the oldest buffered output is dropped beyond it. */
  readonly bufferLimitChars: number
}

export interface ProjectTerminalOptions {
  readonly outputFlushIntervalMs?: number
  readonly outputBufferLimitChars?: number
}

/**
 * Aggregates child-process stdout/stderr chunks and emits them on a fixed
 * throttle instead of one IPC message per chunk. The pending buffer is capped
 * per session: beyond the cap the oldest output is dropped and a single
 * truncation notice is emitted on the next flush.
 */
export class TerminalOutputBatcher {
  private readonly pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private truncated = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly emit: (stream: TerminalOutputStream, data: string) => void,
    private readonly options: TerminalOutputBatcherOptions,
  ) {}

  push(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    this.pending[stream] += chunk.toString()
    const total = this.pending.stdout.length + this.pending.stderr.length
    if (total > this.options.bufferLimitChars) {
      // Truncation drops from stdout first and only then stderr, i.e. in
      // arbitrary per-stream order rather than strict chronological order;
      // the slice can also split a multi-byte character boundary and produce
      // U+FFFD in the first surviving chunk. Both are accepted presentation-
      // layer trade-offs for keeping the hot path simple.
      let excess = total - this.options.bufferLimitChars
      const dropStdout = Math.min(excess, this.pending.stdout.length)
      this.pending.stdout = this.pending.stdout.slice(dropStdout)
      excess -= dropStdout
      if (excess > 0) this.pending.stderr = this.pending.stderr.slice(excess)
      this.truncated = true
    }
    this.schedule()
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const data = this.pending[stream]
      if (data.length === 0) continue
      this.pending[stream] = ''
      this.emit(stream, data)
    }
    if (this.truncated) {
      this.truncated = false
      this.emit('system', TERMINAL_OUTPUT_TRUNCATED_NOTICE)
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.options.flushIntervalMs)
  }
}

function isOnPath(command: string): boolean {
  const pathEnv = process.env['PATH'] ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      if (fs.existsSync(path.join(directory, command + extension.toLowerCase()))) return true
      if (fs.existsSync(path.join(directory, command + extension.toUpperCase()))) return true
    }
  }
  return false
}

function resolveShell(): ShellCommand {
  const configured = process.env['LMCODE_TERMINAL_SHELL']?.trim()
  if (configured) {
    return { command: configured, args: [], label: path.basename(configured) }
  }
  if (process.platform === 'win32') {
    // Some minimal environments (CI shells, service accounts) do not put the
    // PowerShell directory on PATH. Fall back to the well-known install path
    // so the terminal still starts instead of dying with ENOENT.
    const wellKnown = path.join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    const command = isOnPath('powershell.exe')
      ? 'powershell.exe'
      : fs.existsSync(wellKnown)
        ? wellKnown
        : 'powershell.exe'
    return {
      command,
      args: ['-NoLogo', '-NoProfile', '-Command', '-'],
      label: 'PowerShell',
    }
  }
  const command = process.env['SHELL']?.trim() || '/bin/sh'
  return { command, args: [], label: path.basename(command) }
}

function waitTimeout(milliseconds: number): {
  readonly promise: Promise<void>
  readonly cancel: () => void
} {
  const deferred = Promise.withResolvers<void>()
  const timer: NodeJS.Timeout = setTimeout(deferred.resolve, milliseconds)
  return {
    promise: deferred.promise,
    cancel: () => clearTimeout(timer),
  }
}

export class ProjectTerminalManager {
  private readonly terminals = new Map<string, ProjectTerminalEntry>()

  constructor(
    private readonly emitOutput: (payload: TerminalOutputPayload) => void,
    private readonly options: ProjectTerminalOptions = {},
  ) {}

  start(sessionId: string, workDir: string): ProjectTerminalInfo {
    const existing = this.terminals.get(sessionId)
    if (existing && existing.child.exitCode === null) return this.toInfo(existing, true)

    const shell = resolveShell()
    const child = spawn(shell.command, [...shell.args], {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: process.env['NO_COLOR'] ?? '1',
        TERM: process.env['TERM'] ?? 'dumb',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const exit = Promise.withResolvers<void>()
    const batcher = new TerminalOutputBatcher(
      (stream, data) => this.emitOutput({ sessionId, stream, data }),
      {
        flushIntervalMs:
          this.options.outputFlushIntervalMs ?? TERMINAL_OUTPUT_FLUSH_INTERVAL_MS,
        bufferLimitChars:
          this.options.outputBufferLimitChars ?? TERMINAL_OUTPUT_BUFFER_LIMIT_CHARS,
      },
    )
    const entry: ProjectTerminalEntry = {
      sessionId,
      workDir,
      shell: shell.label,
      child,
      exited: exit.promise,
      batcher,
    }
    this.terminals.set(sessionId, entry)

    const forward = (stream: TerminalOutputStream, chunk: Buffer | string): void => {
      if (stream === 'system') {
        // Flush first so buffered output is never reordered after a system line.
        batcher.flush()
        this.emitOutput({ sessionId, stream, data: chunk.toString() })
        return
      }
      batcher.push(stream, chunk)
    }
    child.stdout.on('data', (chunk: Buffer | string) => forward('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer | string) => forward('stderr', chunk))
    // Without this, a write() landing in the window between the shell exiting
    // and exitCode being set raises EPIPE on stdin as an *unhandled* 'error'
    // event — which Node turns into an uncaught exception that crashes the
    // whole main process. The 'close' handler below already reports the exit.
    child.stdin.on('error', () => {})
    child.once('error', (error) => {
      forward('system', `\n[终端启动失败：${error.message}]\n`)
    })
    child.once('close', (code) => {
      if (this.terminals.get(sessionId) === entry) this.terminals.delete(sessionId)
      forward('system', `\n[终端已退出，代码 ${code ?? 'unknown'}]\n`)
      batcher.dispose()
      exit.resolve()
    })

    forward('system', `[${shell.label} · ${workDir}]\n`)
    return this.toInfo(entry, true)
  }

  write(sessionId: string, input: string): void {
    const entry = this.terminals.get(sessionId)
    if (!entry || entry.child.exitCode !== null) throw new Error('当前项目终端未运行')
    if (input.length > TERMINAL_INPUT_LIMIT_CHARS) throw new Error('终端输入过长')
    if (input.includes('\0')) throw new Error('终端输入包含无效字符')
    entry.child.stdin.write(input)
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.terminals.get(sessionId)
    if (!entry) return
    entry.child.stdin.end()
    entry.child.kill()

    const timeout = waitTimeout(TERMINAL_STOP_TIMEOUT_MS)
    await Promise.race([entry.exited, timeout.promise])
    timeout.cancel()
    if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
  }

  async close(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((sessionId) => this.stop(sessionId)))
    this.terminals.clear()
  }

  private toInfo(entry: ProjectTerminalEntry, running: boolean): ProjectTerminalInfo {
    return {
      sessionId: entry.sessionId,
      workDir: entry.workDir,
      shell: entry.shell,
      running,
    }
  }
}
