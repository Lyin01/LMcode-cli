import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  computerUseInstallRecipe,
  detectComputerUseDriver,
} from '@lmcode-cli/lmcode-sdk'

import { terminateChildProcessTree } from './process-tree.js'
import type {
  ComputerUseDriverInfo,
  ComputerUseInstallResult,
} from '../shared/computer-use-types.js'

const VERSION_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** Installer output is a diagnostic tail, not a transcript. */
const OUTPUT_TAIL_CHARS = 4_000
/**
 * What one stream may hold in memory while the process runs. `tail()` only
 * trims the final result, so without this window the full installer log would
 * accumulate first and be cut down afterwards.
 */
const OUTPUT_WINDOW_CHARS = OUTPUT_TAIL_CHARS * 2
/** Temp script the Windows install recipe downloads (see providers.ts). */
const INSTALL_SCRIPT_NAME = 'cua-driver-install.ps1'

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly cancelled: boolean
}

interface ProcessRun {
  readonly result: Promise<ProcessResult>
  /** Signal the whole process tree and report the run as cancelled. */
  readonly abort: () => void
}

/** Keeps only the newest characters: the window is a diagnostic tail. */
function appendToWindow(window: string, chunk: string): string {
  const combined = window + chunk
  return combined.length > OUTPUT_WINDOW_CHARS ? combined.slice(-OUTPUT_WINDOW_CHARS) : combined
}

function run(program: string, args: readonly string[], timeoutMs: number): ProcessRun {
  const child = spawn(program, [...args], { windowsHide: true })
  const outcome = Promise.withResolvers<ProcessResult>()
  const exited = Promise.withResolvers<void>()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let cancelled = false

  // Signal the process tree rather than the direct child: the installer is a
  // PowerShell command that will normally have started the vendor installer as
  // a descendant, and `child.kill()` would leave that descendant running.
  const terminateTree = (): void => {
    void terminateChildProcessTree(child, exited.promise).catch(() => {
      // The run still ends through the child's own 'close'; a tree that
      // outlived the forced phase has no further way to be reported here.
    })
  }

  const timer = setTimeout(() => {
    timedOut = true
    terminateTree()
  }, timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendToWindow(stdout, chunk.toString('utf8'))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendToWindow(stderr, chunk.toString('utf8'))
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    exited.resolve()
    outcome.reject(error)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    exited.resolve()
    outcome.resolve({ code, stdout, stderr, timedOut, cancelled })
  })

  return {
    result: outcome.promise,
    abort: () => {
      cancelled = true
      clearTimeout(timer)
      terminateTree()
    },
  }
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > OUTPUT_TAIL_CHARS ? trimmed.slice(-OUTPUT_TAIL_CHARS) : trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** First non-empty line, which is where the driver prints its version. */
function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

/**
 * Driver availability for the settings screen.
 *
 * Detection is pure filesystem probing. The version probe spawns the driver,
 * which is read-only (`--version`) and therefore safe to run unprompted.
 */
export async function getComputerUseDriverInfo(): Promise<ComputerUseDriverInfo> {
  const driverPath = detectComputerUseDriver(process.platform, process.env)
  if (driverPath === undefined) {
    return { found: false, platform: process.platform }
  }
  try {
    const result = await run(driverPath, ['--version'], VERSION_TIMEOUT_MS).result
    const version = firstLine(result.stdout) ?? firstLine(result.stderr)
    return {
      found: true,
      path: driverPath,
      platform: process.platform,
      ...(version === undefined ? {} : { version }),
    }
  } catch {
    // A driver that cannot report its version is still installed; report the
    // path so the operator can see what was found instead of a bare failure.
    return { found: true, path: driverPath, platform: process.platform }
  }
}

/** Installation currently in flight, shared by concurrent callers. */
let activeInstall: Promise<ComputerUseInstallResult> | null = null
let abortActiveInstall: (() => void) | null = null

/**
 * The Windows install recipe writes its script into the operator's temp
 * directory; remove it afterwards so a cancelled or failed install leaves
 * nothing behind. Best effort, and a no-op on platforms without that script.
 */
function removeInstallScript(): void {
  try {
    fs.rmSync(path.join(os.tmpdir(), INSTALL_SCRIPT_NAME), { force: true })
  } catch {
    // A locked temp file is not worth failing an otherwise finished run over.
  }
}

async function runInstall(): Promise<ComputerUseInstallResult> {
  const recipe = computerUseInstallRecipe(process.platform)
  if (recipe === undefined) {
    return { ok: false, output: '当前平台不支持一键安装，请参考官方文档手动安装。' }
  }

  const install = run(recipe.program, recipe.args, INSTALL_TIMEOUT_MS)
  abortActiveInstall = install.abort
  try {
    const result = await install.result
    if (result.cancelled) return { ok: false, output: '安装已取消。' }
    if (result.timedOut) {
      return { ok: false, output: '安装超时，请检查网络后重试。' }
    }
    const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'))
    if (result.code !== 0) {
      return { ok: false, output: output.length > 0 ? output : `安装脚本退出码 ${String(result.code)}` }
    }
    return { ok: true, output }
  } catch (error) {
    return { ok: false, output: errorMessage(error) }
  } finally {
    abortActiveInstall = null
    removeInstallScript()
  }
}

/**
 * Run the vendor installer for this platform.
 *
 * Only ever called from an explicit confirmation in the settings screen: on
 * Windows this pipes a remote script into PowerShell, which is not something
 * the app should do on its own initiative. The recipe suppresses the vendor's
 * logon autostart task because the driver serves MCP from its own process.
 *
 * Concurrent callers share one run: the vendor script is not reentrant, and
 * two of them racing over the same install directory is how an installation
 * gets corrupted.
 */
export function installComputerUseDriver(): Promise<ComputerUseInstallResult> {
  if (activeInstall === null) {
    activeInstall = runInstall().finally(() => {
      activeInstall = null
    })
  }
  return activeInstall
}

/**
 * Terminate an in-flight installation and report it as cancelled. The app
 * shutdown path calls this: the vendor installer is a PowerShell command that
 * downloads and executes a remote script, and it must not outlive the app.
 */
export function abortComputerUseInstall(): void {
  abortActiveInstall?.()
}
