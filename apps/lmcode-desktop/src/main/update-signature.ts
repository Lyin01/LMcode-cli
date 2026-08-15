import * as childProcess from 'node:child_process'
import * as path from 'node:path'
import type { VerifyUpdateCodeSignature } from 'electron-updater'

const AUTHENTICODE_STATUS_VALID = 0
const AUTHENTICODE_STATUS_UNKNOWN_ERROR = 1
const SIGNATURE_PROBE_TIMEOUT_MS = 20_000
const SIGNATURE_PROBE_MAX_BUFFER_BYTES = 1024 * 1024
const UPDATE_SIGNATURE_FILE_ENV = 'LMCODE_UPDATE_SIGNATURE_FILE'

const TRUSTED_WINDOWS_UPDATE_CERTIFICATE_THUMBPRINTS = new Set([
  '06A885AE9FB11F84060F989991188913711B4D88',
])

const SIGNATURE_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $env:LMCODE_UPDATE_SIGNATURE_FILE
$chainBuilds = $false
$chainStatuses = @()

if ($null -ne $signature.SignerCertificate) {
  $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
    $chainBuilds = $chain.Build($signature.SignerCertificate)
    $chainStatuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
  }
  finally {
    $chain.Dispose()
  }
}

[ordered]@{
  path = $signature.Path
  status = [int]$signature.Status
  statusName = [string]$signature.Status
  statusMessage = $signature.StatusMessage
  thumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
  chainBuildsAllowUnknownCertificateAuthority = $chainBuilds
  chainStatuses = @($chainStatuses)
} | ConvertTo-Json -Compress
`

export interface WindowsUpdateSignatureInfo {
  readonly path: string
  readonly status: number
  readonly statusName: string
  readonly statusMessage: string
  readonly thumbprint: string | null
  readonly chainBuildsAllowUnknownCertificateAuthority: boolean
  readonly chainStatuses: readonly string[]
}

function normalizeThumbprint(value: string | null): string {
  return value?.replaceAll(/[^0-9a-f]/gi, '').toUpperCase() ?? ''
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value).toUpperCase()
}

function parseSignatureProbeOutput(output: string): WindowsUpdateSignatureInfo {
  const parsed: unknown = JSON.parse(output.trim())
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Authenticode signature probe returned an invalid result')
  }

  const value = parsed as Record<string, unknown>
  if (
    typeof value.path !== 'string' ||
    typeof value.status !== 'number' ||
    typeof value.statusName !== 'string' ||
    typeof value.statusMessage !== 'string' ||
    (typeof value.thumbprint !== 'string' && value.thumbprint !== null) ||
    typeof value.chainBuildsAllowUnknownCertificateAuthority !== 'boolean' ||
    !Array.isArray(value.chainStatuses) ||
    !value.chainStatuses.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Authenticode signature probe returned an unexpected shape')
  }

  return {
    path: value.path,
    status: value.status,
    statusName: value.statusName,
    statusMessage: value.statusMessage,
    thumbprint: value.thumbprint,
    chainBuildsAllowUnknownCertificateAuthority:
      value.chainBuildsAllowUnknownCertificateAuthority,
    chainStatuses: value.chainStatuses,
  }
}

async function probeWindowsUpdateSignature(
  updateFile: string,
): Promise<WindowsUpdateSignatureInfo> {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const { promise, resolve, reject } =
    Promise.withResolvers<WindowsUpdateSignatureInfo>()

  childProcess.execFile(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'None',
      '-Command',
      SIGNATURE_PROBE_SCRIPT,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PSModulePath: '',
        [UPDATE_SIGNATURE_FILE_ENV]: updateFile,
      },
      maxBuffer: SIGNATURE_PROBE_MAX_BUFFER_BYTES,
      timeout: SIGNATURE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Authenticode signature probe failed: ${error.message}`))
        return
      }
      if (stderr.trim().length > 0) {
        reject(new Error(`Authenticode signature probe failed: ${stderr.trim()}`))
        return
      }

      try {
        resolve(parseSignatureProbeOutput(stdout))
      }
      catch (parseError) {
        reject(parseError)
      }
    },
  )

  return promise
}

export function evaluateWindowsUpdateSignature(
  signature: WindowsUpdateSignatureInfo,
  updateFile: string,
): string | null {
  if (normalizeWindowsPath(signature.path) !== normalizeWindowsPath(updateFile)) {
    return 'Authenticode verified a different file path'
  }

  const thumbprint = normalizeThumbprint(signature.thumbprint)
  if (!TRUSTED_WINDOWS_UPDATE_CERTIFICATE_THUMBPRINTS.has(thumbprint)) {
    return `Update signer certificate is not pinned (${thumbprint || 'missing thumbprint'})`
  }

  if (signature.status === AUTHENTICODE_STATUS_VALID) {
    return null
  }

  const hasOnlyUntrustedRoot =
    signature.chainStatuses.length === 1 &&
    signature.chainStatuses[0] === 'UntrustedRoot'
  if (
    signature.status === AUTHENTICODE_STATUS_UNKNOWN_ERROR &&
    signature.chainBuildsAllowUnknownCertificateAuthority &&
    hasOnlyUntrustedRoot
  ) {
    return null
  }

  return `Authenticode rejected the update (${signature.statusName}: ${signature.statusMessage})`
}

export const verifyWindowsUpdateCodeSignature: VerifyUpdateCodeSignature = async (
  _publisherNames,
  updateFile,
) => {
  const signature = await probeWindowsUpdateSignature(updateFile)
  return evaluateWindowsUpdateSignature(signature, updateFile)
}
