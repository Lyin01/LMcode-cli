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
] as const

const BLOCKED_MCP_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.google.com',
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
 * which would be host RCE for anyone holding the pairing token.
 */
export function assertRemoteSafeMcpConfig(config: Record<string, unknown>): void {
  const command = config['command']
  if (typeof command === 'string' && command.trim().length > 0) {
    throw new Error('Remote MCP servers must use an HTTP/SSE url, not a local stdio command')
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
  if (BLOCKED_MCP_HOSTS.has(hostname) || hostname.endsWith('.internal')) {
    throw new Error('Remote MCP url cannot target cloud metadata or internal-only hosts')
  }
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
