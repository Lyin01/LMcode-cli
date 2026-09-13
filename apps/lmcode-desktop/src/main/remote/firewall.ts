import { spawn } from 'node:child_process'
import type { RemoteFirewallStatus } from '../../shared/remote-types.js'

/**
 * Inbound Windows Firewall rule that opens the LAN remote port to phones on
 * the same network. Created by the installer (when it runs elevated), by the
 * release tooling on the development machine, or on demand from the remote
 * connect dialog ("一键放行", which triggers the UAC consent dialog).
 */
export const REMOTE_FIREWALL_RULE_NAME = 'LMCODE Desktop Remote (LAN)'

const POWER_SHELL = 'powershell.exe'
const STATUS_TIMEOUT_MS = 20_000
const REPAIR_TIMEOUT_MS = 180_000

interface PowerShellResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/** Script printing the program path of every rule named `ruleName`. */
export function buildFirewallStatusScript(ruleName: string): string {
  const name = escapePowerShellLiteral(ruleName)
  return `(Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program`
}

/** Script (run elevated) that (re)creates the inbound LAN rule for `execPath`. */
export function buildFirewallRepairScript(ruleName: string, execPath: string): string {
  const name = escapePowerShellLiteral(ruleName)
  const exe = escapePowerShellLiteral(execPath)
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${name}' -Description 'Allow devices on the local subnet to reach the LMCODE Desktop remote server (phone scan-to-connect).' -Direction Inbound -Program '${exe}' -Protocol TCP -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null`,
  ].join('; ')
}

/**
 * Outer script executed non-elevated: it re-launches PowerShell through the
 * UAC consent dialog (`-Verb RunAs`) and waits for the repair to finish. The
 * inner script travels as a base64-encoded command so no quoting survives
 * between the two processes.
 */
export function buildFirewallRepairLaunchScript(ruleName: string, execPath: string): string {
  const inner = escapePowerShellLiteral(buildFirewallRepairScript(ruleName, execPath))
  return [
    `$inner = '${inner}'`,
    `$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))`,
    `Start-Process -FilePath '${POWER_SHELL}' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$encoded`,
  ].join('; ')
}

/** One program path per line, blank lines dropped. */
export function parseFirewallProgramList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** True when any listed rule program equals `execPath` (case/separator insensitive). */
export function isProgramCoveredByFirewallRules(
  programs: readonly string[],
  execPath: string,
): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
  const target = normalize(execPath)
  return programs.some((program) => normalize(program) === target)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeLaunchFailure(result: PowerShellResult): string {
  const output = `${result.stderr}\n${result.stdout}`
  if (/canceled by the user|操作已被用户取消|cancelled by the user/i.test(output)) {
    return '已取消管理员授权'
  }
  const firstLine = parseFirewallProgramList(result.stderr).at(0) ?? parseFirewallProgramList(result.stdout).at(0)
  return firstLine ?? `PowerShell exited with code ${String(result.code)}`
}

function runPowerShell(script: string, timeoutMs: number): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(POWER_SHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`PowerShell timed out after ${timeoutMs}ms`))
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
      resolve({ code, stdout, stderr })
    })
  })
}

/** Current firewall coverage for the running executable (Windows only). */
export async function getRemoteFirewallStatus(execPath: string): Promise<RemoteFirewallStatus> {
  if (process.platform !== 'win32') return { supported: false, allowed: false }
  try {
    const result = await runPowerShell(
      buildFirewallStatusScript(REMOTE_FIREWALL_RULE_NAME),
      STATUS_TIMEOUT_MS,
    )
    return {
      supported: true,
      allowed: isProgramCoveredByFirewallRules(
        parseFirewallProgramList(result.stdout),
        execPath,
      ),
    }
  } catch (error) {
    return { supported: true, allowed: false, error: errorMessage(error) }
  }
}

/**
 * Ask for elevation (UAC) to add the inbound rule, then re-check. Resolves
 * with the post-repair status; `error` is set when the user declined the
 * prompt, the command failed, or the rule still did not land.
 */
export async function repairRemoteFirewall(execPath: string): Promise<RemoteFirewallStatus> {
  if (process.platform !== 'win32') return { supported: false, allowed: false }
  try {
    const launch = await runPowerShell(
      buildFirewallRepairLaunchScript(REMOTE_FIREWALL_RULE_NAME, execPath),
      REPAIR_TIMEOUT_MS,
    )
    if (launch.code !== 0) {
      return { supported: true, allowed: false, error: describeLaunchFailure(launch) }
    }
  } catch (error) {
    return { supported: true, allowed: false, error: errorMessage(error) }
  }
  return await getRemoteFirewallStatus(execPath)
}
