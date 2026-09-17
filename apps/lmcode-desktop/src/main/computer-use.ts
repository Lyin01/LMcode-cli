import { spawn } from 'node:child_process'

import {
  computerUseInstallRecipe,
  detectComputerUseDriver,
} from '@lmcode-cli/lmcode-sdk'

import type {
  ComputerUseDriverInfo,
  ComputerUseInstallResult,
} from '../shared/computer-use-types.js'

const VERSION_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** Installer output is a diagnostic tail, not a transcript. */
const OUTPUT_TAIL_CHARS = 4_000

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function run(program: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
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
    const result = await run(driverPath, ['--version'], VERSION_TIMEOUT_MS)
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

/**
 * Run the vendor installer for this platform.
 *
 * Only ever called from an explicit confirmation in the settings screen: on
 * Windows this pipes a remote script into PowerShell, which is not something
 * the app should do on its own initiative. The recipe suppresses the vendor's
 * logon autostart task because the driver serves MCP from its own process.
 */
export async function installComputerUseDriver(): Promise<ComputerUseInstallResult> {
  const recipe = computerUseInstallRecipe(process.platform)
  if (recipe === undefined) {
    return { ok: false, output: '当前平台不支持一键安装，请参考官方文档手动安装。' }
  }
  try {
    const result = await run(recipe.program, recipe.args, INSTALL_TIMEOUT_MS)
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
  }
}
