import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkShellOpenTarget } from '../src/main/shell-open-target'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lmcode-shell-open-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('checkShellOpenTarget', () => {
  it('blocks an extensionless path that resolves to a sibling executable on Windows', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'launcher'), 'not really a program')
    await writeFile(join(dir, 'launcher.exe'), 'stub')

    const check = await checkShellOpenTarget(join(dir, 'launcher'), 'win32')

    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('可执行文件')
  })

  it('blocks extensionless paths with a trailing dot that still resolve to an executable', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'setup.'), 'not really a program')
    await writeFile(join(dir, 'setup.exe'), 'stub')

    const check = await checkShellOpenTarget(join(dir, 'setup.'), 'win32')

    expect(check.ok).toBe(false)
  })

  it('allows an extensionless text file when no executable sibling exists', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'README'), 'hello')

    await expect(checkShellOpenTarget(join(dir, 'README'), 'win32')).resolves.toEqual({ ok: true })
  })

  it('allows files with a regular extension and directories', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'notes.txt'), 'hello')

    await expect(checkShellOpenTarget(join(dir, 'notes.txt'), 'win32')).resolves.toEqual({
      ok: true,
    })
    await expect(checkShellOpenTarget(dir, 'win32')).resolves.toEqual({ ok: true })
  })

  it('rejects missing paths', async () => {
    const dir = await makeTempDir()

    const check = await checkShellOpenTarget(join(dir, 'nope'), 'win32')

    expect(check.ok).toBe(false)
  })
})
