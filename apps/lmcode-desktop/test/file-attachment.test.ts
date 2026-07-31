import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopPromptInput,
  isSensitiveAttachmentPath,
  readFileAttachment,
  readInlineImageAttachment,
  readTextAttachment,
  TEXT_ATTACHMENT_LIMIT_BYTES,
} from '../src/main/file-attachment'
import { MAX_PROMPT_ATTACHMENTS, parseTextAttachmentPart } from '../src/shared/file-types'

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
    const uppercaseEnvPath = await temporaryFile('.ENV.LOCAL', 'API_KEY=secret')
    const pemPath = await temporaryFile('server.pem', '-----BEGIN-----')
    const cookiesPath = await temporaryFile('site_cookies.json', '{}')
    const browserCookiesPath = await temporaryFile('Cookies', '{}')

    await expect(readTextAttachment(envPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(envLocalPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(uppercaseEnvPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(pemPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(cookiesPath)).rejects.toThrow('安全考虑')
    await expect(readTextAttachment(browserCookiesPath)).rejects.toThrow('安全考虑')
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

describe('desktop multimodal attachments', () => {
  it('detects supported images by bytes and returns a model-ready data URL', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const filePath = await temporaryFile('screen.png', png)

    await expect(readFileAttachment(filePath)).resolves.toEqual({
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    })
  })

  it('builds one typed SDK prompt containing user text, text files, and images', async () => {
    const textPath = await temporaryFile('notes.md', '# Findings')
    const imagePath = await temporaryFile(
      'screen.png',
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    )

    const parts = await buildDesktopPromptInput({
      text: 'Review these attachments',
      attachments: [
        { source: 'path', kind: 'text', filePath: textPath },
        { source: 'path', kind: 'image', filePath: imagePath },
      ],
    })

    expect(parts[0]).toEqual({ type: 'text', text: 'Review these attachments' })
    expect(parts[1]?.type).toBe('text')
    if (parts[1]?.type !== 'text') throw new Error('Expected a text attachment part')
    expect(parseTextAttachmentPart(parts[1].text)).toEqual({
      metadata: { name: 'notes.md', sizeBytes: 10, truncated: false },
      content: '# Findings',
    })
    expect(parts[2]).toMatchObject({
      type: 'image_url',
      imageUrl: { id: 'screen.png', url: expect.stringMatching(/^data:image\/png;base64,/) },
    })
  })

  it('accepts an image-only prompt and enforces the attachment count contract', async () => {
    const imagePath = await temporaryFile(
      'screen.png',
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    )

    await expect(buildDesktopPromptInput({
      text: '',
      attachments: [{ source: 'path', kind: 'image', filePath: imagePath }],
    })).resolves.toHaveLength(1)

    await expect(buildDesktopPromptInput({
      text: 'too many',
      attachments: Array.from({ length: MAX_PROMPT_ATTACHMENTS + 1 }, () => ({
        source: 'path' as const,
        kind: 'image' as const,
        filePath: imagePath,
      })),
    })).rejects.toThrow(`最多附加 ${MAX_PROMPT_ATTACHMENTS} 个文件`)
  })

  it('rejects an attachment whose contents changed type after preview', async () => {
    const filePath = await temporaryFile('changed.dat', 'plain text')
    await expect(buildDesktopPromptInput({
      text: 'inspect',
      attachments: [{ source: 'path', kind: 'image', filePath }],
    })).rejects.toThrow('类型已变化')
  })

  it('validates a pathless clipboard image and includes it in the SDK prompt', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`

    expect(readInlineImageAttachment('', dataUrl)).toEqual({
      kind: 'image',
      name: 'clipboard.png',
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      dataUrl,
    })
    await expect(buildDesktopPromptInput({
      text: '',
      attachments: [{
        source: 'inline',
        kind: 'image',
        name: 'pasted.png',
        dataUrl,
      }],
    })).resolves.toEqual([{
      type: 'image_url',
      imageUrl: { id: 'pasted.png', url: dataUrl },
    }])
  })

  it('rejects malformed or MIME-spoofed clipboard image data', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const encoded = Buffer.from(png).toString('base64')

    expect(() => readInlineImageAttachment('screen.jpg', `data:image/jpeg;base64,${encoded}`))
      .toThrow('文件内容不一致')
    expect(() => readInlineImageAttachment('screen.png', 'data:image/png;base64,abc'))
      .toThrow('图片数据无效')
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
    expect(isSensitiveAttachmentPath(inHome('Library', 'Browser', 'Cookies'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('project', '.ENV.PRODUCTION'))).toBe(true)
    expect(isSensitiveAttachmentPath(inHome('project', 'CLIENT.P12'))).toBe(true)
  })

  it('blocks credentials inside profile-specific desktop data directories', async () => {
    const desktopData = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-desktop-data-'))
    temporaryDirectories.push(desktopData)
    const configPath = path.join(desktopData, 'config.toml')
    await fs.writeFile(configPath, 'api_key = "runtime-secret"')

    expect(isSensitiveAttachmentPath(configPath, [desktopData])).toBe(true)
    await expect(readTextAttachment(configPath, [desktopData])).rejects.toThrow('安全考虑')
  })

  it('does not over-block ordinary files, including non-secret files under ~/.lmcode', () => {
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'sessions', 'abc', 'events.jsonl'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('.lmcode', 'memory', 'note.md'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'config.toml'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'src', 'index.ts'))).toBe(false)
    expect(isSensitiveAttachmentPath(inHome('project', 'env.example'))).toBe(false)
  })
})
