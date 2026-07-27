import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isSensitiveAttachmentPath,
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

  it('rejects credential and secret files even though they are valid UTF-8', async () => {
    const envPath = await temporaryFile('.env', 'API_KEY=secret')
    const envLocalPath = await temporaryFile('.env.local', 'API_KEY=secret')
    const pemPath = await temporaryFile('server.pem', '-----BEGIN-----')
    const cookiesPath = await temporaryFile('site_cookies.json', '{}')

    await expect(readTextAttachment(envPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(envLocalPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(pemPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(cookiesPath)).rejects.toThrow('安全考虑')
  })

  it('rejects a symlink that points at a sensitive file', async () => {
    const envPath = await temporaryFile('.env', 'API_KEY=secret')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-attachment-'))
    temporaryDirectories.push(directory)
    const linkPath = path.join(directory, 'innocent.txt')
    try {
      await fs.symlink(envPath, linkPath)
    } catch {
      // Windows requires elevated privileges for file symlinks; nothing to test.
      return
    }

    await expect(readTextAttachment(linkPath)).rejects.toThrow('安全考虑')
  })
})

describe('sensitive attachment path denylist', () => {
  const home = os.homedir()
  const inHome = (...segments: string[]) => path.join(home, ...segments)

  it('blocks app config, device id and credential stores under the home directory', () => {
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'config.toml'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'config.toml.bak'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'device_id'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.ssh', 'id_rsa'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.gnupg', 'secring.gpg'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.aws', 'credentials'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('.kube', 'config'))).toBe(true)
  })

  it('does not over-block ordinary files, including non-secret files under ~/.lmcode', () => {
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'sessions', 'abc', 'events.jsonl'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'memory', 'note.md'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'config.toml'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'src', 'index.ts'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'env.example'))).toBe(false)
  })
})
