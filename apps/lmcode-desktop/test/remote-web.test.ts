import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRemoteWebAsset } from '../src/main/remote/remote-web'

let root: string
let parent: string

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'lmcode-remote-web-'))
  root = join(parent, 'app')
  await mkdir(root)
  await writeFile(join(root, 'index.html'), '<!doctype html><title>LMCODE 远程</title>')
  await writeFile(join(root, 'app.css'), 'body { color: red }')
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets', 'logo.svg'), '<svg></svg>')
  await writeFile(join(parent, 'secret.txt'), 'top-secret')
})

afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

describe('readRemoteWebAsset', () => {
  it('serves index.html for the root path', async () => {
    const asset = await readRemoteWebAsset(root, '/')
    expect(asset?.contentType).toBe('text/html; charset=utf-8')
    expect(asset?.body.toString('utf8')).toContain('LMCODE')
  })

  it('maps nested files to content types and ignores query strings', async () => {
    expect((await readRemoteWebAsset(root, '/app.css'))?.contentType).toBe(
      'text/css; charset=utf-8',
    )
    expect((await readRemoteWebAsset(root, '/assets/logo.svg?v=2'))?.contentType).toBe(
      'image/svg+xml',
    )
  })

  it('returns null for missing files and directories', async () => {
    expect(await readRemoteWebAsset(root, '/missing.js')).toBeNull()
    expect(await readRemoteWebAsset(root, '/assets')).toBeNull()
  })

  it('refuses traversal out of the web root in plain, encoded and backslash forms', async () => {
    expect(await readRemoteWebAsset(root, '/../secret.txt')).toBeNull()
    expect(await readRemoteWebAsset(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(await readRemoteWebAsset(root, '/..%5Csecret.txt')).toBeNull()
    expect(await readRemoteWebAsset(root, '/C:/Windows/win.ini')).toBeNull()
  })

  it('rejects malformed percent-encoding and null bytes', async () => {
    expect(await readRemoteWebAsset(root, '/%zz')).toBeNull()
    expect(await readRemoteWebAsset(root, '/app%00.css')).toBeNull()
  })
})
