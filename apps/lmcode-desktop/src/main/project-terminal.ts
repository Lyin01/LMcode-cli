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
    const entry: ProjectTerminalEntry = {
      sessionId,
      workDir,
      shell: shell.label,
      child,
      exited: exit.promise,
    }
    this.terminals.set(sessionId, entry)

    const forward = (stream: TerminalOutputStream, chunk: Buffer | string): void => {
      this.emitOutput({ sessionId, stream, data: chunk.toString() })
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
