import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readTextAttachment,
  TEXT_ATTACHMENT_LIMIT_BYTES,
} from '../src/main/file-attachment'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-attachment-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, name)
  await fs.writeFile(filePath, content)
  return filePath
}

describe('desktop text attachments', () => {
  it('bounds the text inserted into a model prompt while reporting the original size', async () => {
    const content = 'x'.repeat(TEXT_ATTACHMENT_LIMIT_BYTES + 128)
    const filePath = await temporaryFile('large.txt', content)

    await expect(readTextAttachment(filePath)).resolves.toEqual({
      content: 'x'.repeat(TEXT_ATTACHMENT_LIMIT_BYTES),
      sizeBytes: TEXT_ATTACHMENT_LIMIT_BYTES + 128,
      truncated: true,
    })
  })

  it('rejects binary and non-UTF-8 payloads instead of embedding them in chat', async () => {
    const binaryPath = await temporaryFile('binary.bin', new Uint8Array([65, 0, 66]))
    const invalidUtf8Path = await temporaryFile('invalid.txt', new Uint8Array([0xff, 0xfe]))

    await expect(readTextAttachment(binaryPath)).rejects.toThrow('二进制文件')
    await expect(readTextAttachment(invalidUtf8Path)).rejects.toThrow('UTF-8')
  })

  it('does not reject valid UTF-8 when a multi-byte character crosses the preview boundary', async () => {
    const prefix = 'x'.repeat(TEXT_ATTACHMENT_LIMIT_BYTES - 1)
    const filePath = await temporaryFile('boundary.txt', `${prefix}你tail`)

    await expect(readTextAttachment(filePath)).resolves.toEqual({
      content: prefix,
      sizeBytes: TEXT_ATTACHMENT_LIMIT_BYTES - 1 + Buffer.byteLength('你tail'),
      truncated: true,
    })
  })
})
