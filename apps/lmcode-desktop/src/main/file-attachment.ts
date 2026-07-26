import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { TextAttachment } from '../shared/file-types.js'

export const TEXT_ATTACHMENT_LIMIT_BYTES = 256 * 1024

export async function readTextAttachment(filePath: string): Promise<TextAttachment> {
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new Error('附件路径无效')
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
