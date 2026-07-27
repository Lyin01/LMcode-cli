import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TextAttachment } from '../shared/file-types.js'

export const TEXT_ATTACHMENT_LIMIT_BYTES = 256 * 1024

/** Home-directory credential stores that must never enter a model prompt. */
const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube']
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.kdbx'])

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Denylist for paths whose contents are credentials or secrets. The renderer
 * can ask for any absolute path, so this is the barrier that keeps a
 * compromised/XSS'd renderer (or an accidental click) from exfiltrating API
 * keys into a model prompt. It is intentionally a denylist on top of the
 * explicit user file pick — not a full sandbox.
 */
export function isSensitiveAttachmentPath(filePath: string): boolean {
  const target = normalizeForCompare(filePath)
  const home = normalizeForCompare(os.homedir())
  const base = path.basename(target)

  // ~/.lmcode/config.toml (+ its *.bak backups) stores provider API keys;
  // device_id identifies this install. The rest of ~/.lmcode (sessions,
  // memory, logs) stays attachable on purpose.
  const lmcodeDir = path.join(home, '.lmcode') + path.sep
  if (target.startsWith(lmcodeDir)) {
    if (base === 'device_id' || base.startsWith('config.toml')) return true
  }

  for (const dir of SENSITIVE_HOME_DIRS) {
    if (target.startsWith(path.join(home, dir) + path.sep)) return true
  }

  // Env files anywhere in the tree (.env, .env.local, .env.production, …).
  if (base === '.env' || base.startsWith('.env.')) return true

  if (SENSITIVE_EXTENSIONS.has(path.extname(base))) return true
  if (base.includes('cookie')) return true

  return false
}

export async function readTextAttachment(filePath: string): Promise<TextAttachment> {
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new Error('附件路径无效')
  }

  // Resolve symlinks first so a link inside an innocent directory cannot
  // point at a sensitive file.
  const realPath = await fs.realpath(filePath).catch(() => filePath)
  if (isSensitiveAttachmentPath(filePath) || isSensitiveAttachmentPath(realPath)) {
    throw new Error('出于安全考虑，不能附加此文件')
  }

  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('只能附加普通文件')

    const bytesToRead = Math.min(stat.size, TEXT_ATTACHMENT_LIMIT_BYTES + 1)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const truncated = stat.size > TEXT_ATTACHMENT_LIMIT_BYTES
    const preview = buffer.subarray(0, Math.min(bytesRead, TEXT_ATTACHMENT_LIMIT_BYTES))
    if (preview.includes(0)) throw new Error('暂不支持附加二进制文件')

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(preview, {
        // A valid multi-byte character can cross the preview boundary. Streaming
        // keeps that incomplete suffix out of the prompt without misclassifying
        // the entire source file as malformed UTF-8.
        stream: truncated,
      })
    } catch {
      throw new Error('附件不是有效的 UTF-8 文本文件')
    }

    return {
      content,
      sizeBytes: stat.size,
      truncated,
    }
  } finally {
    await handle.close()
  }
}
