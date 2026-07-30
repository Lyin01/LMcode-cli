import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PromptInput } from '@lmcode-cli/lmcode-sdk'
import {
  MAX_PROMPT_ATTACHMENTS,
  isDesktopPromptRequest,
  serializeTextAttachmentPart,
  type DesktopPromptRequest,
  type FileAttachmentPreview,
  type ImageFileAttachmentPreview,
  type TextAttachment,
  type TextFileAttachmentPreview,
} from '../shared/file-types.js'

export const TEXT_ATTACHMENT_LIMIT_BYTES = 256 * 1024
export const IMAGE_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024

/** Home-directory credential stores that must never enter a model prompt. */
const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube']
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.kdbx'])

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

interface ResolvedAttachmentFile {
  readonly realPath: string
  readonly name: string
  readonly sizeBytes: number
}

async function resolveAttachmentFile(filePath: string): Promise<ResolvedAttachmentFile> {
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new Error('附件路径无效')
  }

  const realPath = await fs.realpath(filePath).catch(() => filePath)
  if (isSensitiveAttachmentPath(filePath) || isSensitiveAttachmentPath(realPath)) {
    throw new Error('出于安全考虑，不能附加此文件')
  }

  const stat = await fs.stat(realPath)
  if (!stat.isFile()) throw new Error('只能附加普通文件')
  return { realPath, name: path.basename(realPath), sizeBytes: stat.size }
}

function detectSupportedImageMime(
  header: Buffer,
): ImageFileAttachmentPreview['mimeType'] | null {
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) return 'image/png'
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg'
  }
  const signature = header.subarray(0, 6).toString('ascii')
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

function defaultImageName(mimeType: ImageFileAttachmentPreview['mimeType']): string {
  const suffix = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)
  return `clipboard.${suffix}`
}

function imagePreviewFromData(
  name: string,
  data: Buffer,
  declaredMimeType?: ImageFileAttachmentPreview['mimeType'],
): ImageFileAttachmentPreview {
  if (data.length === 0) throw new Error('图片文件为空')
  if (data.length > IMAGE_ATTACHMENT_LIMIT_BYTES) throw new Error('图片超过 10 MB 限制')
  const mimeType = detectSupportedImageMime(data.subarray(0, 16))
  if (mimeType === null || (declaredMimeType !== undefined && mimeType !== declaredMimeType)) {
    throw new Error('图片格式无效或与文件内容不一致')
  }
  const normalizedName = path.basename(name.trim()) || defaultImageName(mimeType)
  return {
    kind: 'image',
    name: normalizedName.slice(0, 255),
    mimeType,
    sizeBytes: data.length,
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}`,
  }
}

export function readInlineImageAttachment(
  name: string,
  dataUrl: string,
): ImageFileAttachmentPreview {
  if (typeof name !== 'string' || typeof dataUrl !== 'string') {
    throw new Error('剪贴板图片数据无效')
  }
  const maximumEncodedLength = Math.ceil(IMAGE_ATTACHMENT_LIMIT_BYTES / 3) * 4
  if (dataUrl.length > maximumEncodedLength + 64) {
    throw new Error('图片超过 10 MB 限制')
  }
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  if (!match) throw new Error('剪贴板图片数据无效')
  const mimeType = match[1] as ImageFileAttachmentPreview['mimeType']
  const encoded = match[2] ?? ''
  if (encoded.length > maximumEncodedLength) {
    throw new Error('图片超过 10 MB 限制')
  }
  if (encoded.length % 4 !== 0) throw new Error('剪贴板图片数据无效')
  return imagePreviewFromData(name, Buffer.from(encoded, 'base64'), mimeType)
}

async function readTextAttachmentFile(
  file: ResolvedAttachmentFile,
): Promise<TextAttachment> {
  const handle = await fs.open(file.realPath, 'r')
  try {
    const bytesToRead = Math.min(file.sizeBytes, TEXT_ATTACHMENT_LIMIT_BYTES + 1)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const truncated = file.sizeBytes > TEXT_ATTACHMENT_LIMIT_BYTES
    const preview = buffer.subarray(0, Math.min(bytesRead, TEXT_ATTACHMENT_LIMIT_BYTES))
    if (preview.includes(0)) throw new Error('暂不支持附加此二进制文件')

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(preview, {
        stream: truncated,
      })
    } catch {
      throw new Error('附件不是有效的 UTF-8 文本文件')
    }

    return { content, sizeBytes: file.sizeBytes, truncated }
  } finally {
    await handle.close()
  }
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
  const base = path.basename(target).toLowerCase()

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
  return readTextAttachmentFile(await resolveAttachmentFile(filePath))
}

export async function readFileAttachment(filePath: string): Promise<FileAttachmentPreview> {
  const file = await resolveAttachmentFile(filePath)
  const handle = await fs.open(file.realPath, 'r')
  let header: Buffer
  try {
    header = Buffer.alloc(Math.min(file.sizeBytes, 16))
    await handle.read(header, 0, header.length, 0)
  } finally {
    await handle.close()
  }

  const mimeType = detectSupportedImageMime(header)
  if (mimeType !== null) {
    const data = await fs.readFile(file.realPath)
    return imagePreviewFromData(file.name, data, mimeType)
  }

  const text = await readTextAttachmentFile(file)
  const preview: TextFileAttachmentPreview = {
    kind: 'text',
    name: file.name,
    ...text,
  }
  return preview
}

export async function buildDesktopPromptInput(value: unknown): Promise<PromptInput> {
  if (!isDesktopPromptRequest(value)) throw new Error('消息附件参数无效')
  const request: DesktopPromptRequest = value
  if (request.attachments.length > MAX_PROMPT_ATTACHMENTS) {
    throw new Error(`每条消息最多附加 ${MAX_PROMPT_ATTACHMENTS} 个文件`)
  }

  const parts: PromptInput[number][] = []
  const text = request.text.trim()
  if (text) parts.push({ type: 'text', text })

  const seenPaths = new Set<string>()
  for (const input of request.attachments) {
    let attachment: FileAttachmentPreview
    if (input.source === 'path') {
      const pathKey = normalizeForCompare(input.filePath)
      if (seenPaths.has(pathKey)) continue
      seenPaths.add(pathKey)
      attachment = await readFileAttachment(input.filePath)
      if (attachment.kind !== input.kind) {
        throw new Error(`附件“${attachment.name}”的类型已变化，请重新添加`)
      }
    } else {
      attachment = readInlineImageAttachment(input.name, input.dataUrl)
    }
    if (attachment.kind === 'text') {
      parts.push({ type: 'text', text: serializeTextAttachmentPart(attachment) })
    } else {
      parts.push({
        type: 'image_url',
        imageUrl: { url: attachment.dataUrl, id: attachment.name },
      })
    }
  }

  if (parts.length === 0) throw new Error('消息内容不能为空')
  return parts
}
