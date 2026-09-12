import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Static serving for the built-in mobile page, served by the remote HTTP
 * server next to the WebSocket endpoint.
 *
 * Security posture: the remote service is reachable from the LAN (or a tunnel),
 * so this layer never lists directories, only serves `GET`/`HEAD`, refuses to
 * escape the build output directory and marks every response `no-store` so an
 * updated desktop app never hands out a stale page.
 */
export interface RemoteWebAsset {
  readonly body: Buffer
  readonly contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Headers for every static asset response. The CSP keeps the page limited to
 * its own origin (`connect-src ws: wss:` covers the WebSocket, including
 * tunnels that terminate TLS upstream).
 */
export const REMOTE_WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ws: wss:; base-uri 'none'; frame-ancestors 'none'",
}

/**
 * Resolve one request URL to a file under `webRoot`. Returns `null` for
 * anything that is not a readable regular file inside the root — traversal
 * attempts (`..`, encoded or backslash variants, absolute paths) included.
 */
export async function readRemoteWebAsset(
  webRoot: string,
  requestUrl: string,
): Promise<RemoteWebAsset | null> {
  const rawPath = requestUrl.replace(/[?#].*$/, '')
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const relative = decoded === '/' || decoded.length === 0 ? 'index.html' : decoded.replace(/^\/+/, '')
  const root = path.resolve(webRoot)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null

  let info
  try {
    info = await stat(resolved)
  } catch {
    return null
  }
  if (!info.isFile()) return null

  let body: Buffer
  try {
    body = await readFile(resolved)
  } catch {
    return null
  }
  const extension = path.extname(resolved).toLowerCase()
  return {
    body,
    contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
  }
}
