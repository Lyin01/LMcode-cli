import path from 'node:path'

const REMOTE_FORBIDDEN_CONFIG_KEYS = [
  'yolo',
  'defaultPermissionMode',
  'permission',
  'hooks',
  'extraSkillDirs',
  'planMode',
  'defaultPlanMode',
  'defaultFileSandbox',
  'enableSelfHealing',
  'mergeAllAvailableSkills',
  'loopControl',
  'background',
  'providers',
  'services',
  'computerUse',
] as const

const BLOCKED_MCP_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.azure.com',
  'kubernetes.default.svc',
])

/** Existing project directories only — never a fresh path chosen by the client. */
export function isAllowedRemoteWorkDir(
  requested: string,
  allowed: readonly string[],
): boolean {
  const resolved = path.resolve(requested.trim())
  if (resolved.length === 0) return false
  for (const dir of allowed) {
    const candidate = path.resolve(dir)
    if (process.platform === 'win32') {
      if (candidate.toLowerCase() === resolved.toLowerCase()) return true
    } else if (candidate === resolved) {
      return true
    }
  }
  return false
}

/**
 * Remote MCP add is HTTP/SSE only. A `command` field is local stdio spawn,
 * which would be host RCE for anyone holding the pairing token. The same
 * applies to `bearerTokenEnvVar`, which would let a remote caller exfiltrate
 * arbitrary host environment variables (API keys, tokens) to its own server.
 */
export function assertRemoteSafeMcpConfig(config: Record<string, unknown>): void {
  if (Object.hasOwn(config, 'command') || Object.hasOwn(config, 'args')) {
    throw new Error('Remote MCP servers must use an HTTP/SSE url, not a local stdio command')
  }
  if (Object.hasOwn(config, 'bearerTokenEnvVar')) {
    throw new Error('Remote MCP servers cannot read host environment variables')
  }
  const url = config['url']
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('Remote MCP add requires an http(s) url')
  }
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('Remote MCP url is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Remote MCP url must use http or https')
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    BLOCKED_MCP_HOSTS.has(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    isBlockedMcpAddress(hostname)
  ) {
    throw new Error('Remote MCP url cannot target loopback, metadata, or internal-only hosts')
  }
}

function isBlockedMcpAddress(host: string): boolean {
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return true
    }
    const mapped = parseIpv4MappedIpv6(host)
    return mapped !== null && isBlockedIpv4(mapped)
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const octets: readonly [number, number, number, number] = [
    Number(v4[1]),
    Number(v4[2]),
    Number(v4[3]),
    Number(v4[4]),
  ]
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  return isBlockedIpv4(octets)
}

function parseIpv4MappedIpv6(host: string): readonly [number, number, number, number] | null {
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(host)
  if (dotted !== null) {
    return [Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4])]
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (hex === null) return null
  const hi = Number.parseInt(hex[1]!, 16)
  const lo = Number.parseInt(hex[2]!, 16)
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
}

function isBlockedIpv4([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 127 ||
    a === 0 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** Pairing token must not persist hooks, yolo, or other host-execution settings. */
export function assertRemoteSafeConfigPatch(patch: Record<string, unknown>): void {
  const blocked = REMOTE_FORBIDDEN_CONFIG_KEYS.filter((key) => Object.hasOwn(patch, key))
  if (blocked.length > 0) {
    throw new Error(`Remote config.set cannot change: ${blocked.join(', ')}`)
  }
}

export function assertRemoteSafePermissionMode(mode: string): void {
  if (mode === 'yolo') {
    throw new Error('Remote clients cannot enable yolo permission mode')
  }
}
