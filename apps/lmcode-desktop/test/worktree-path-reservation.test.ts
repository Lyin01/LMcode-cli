import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  removeEmptyWorktreeDirectory,
  reserveWorktreePath,
} from '../src/main/worktree-path-reservation'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-worktree-reservation-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('worktree path reservation', () => {
  it('gives concurrent reservations for one slug distinct paths and releases cleanly', async () => {
    const baseDir = await temporaryDirectory()
    const [first, second] = await Promise.all([
      reserveWorktreePath(baseDir, 'feature/concurrent'),
      reserveWorktreePath(baseDir, 'feature/concurrent'),
    ])

    expect(first.path).not.toBe(second.path)
    expect([path.basename(first.path), path.basename(second.path)].sort()).toEqual([
      'feature-concurrent',
      'feature-concurrent-2',
    ])

    await Promise.all([first.release(), second.release()])
    // Released reservations leave no lock files behind.
    await expect(
      fs.readdir(path.join(baseDir, '.lmcode-worktree-reservations')),
    ).resolves.toEqual([])
  })

  it('skips an existing target while leaving its contents untouched', async () => {
    const baseDir = await temporaryDirectory()
    const existing = path.join(baseDir, 'feature-existing')
    const sentinel = path.join(existing, 'sentinel.txt')
    await fs.mkdir(existing)
    await fs.writeFile(sentinel, 'keep')

    const reservation = await reserveWorktreePath(baseDir, 'feature/existing')

    expect(path.basename(reservation.path)).toBe('feature-existing-2')
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('keep')
    await reservation.release()
  })

  it('never removes a non-empty worktree during failure cleanup', async () => {
    const baseDir = await temporaryDirectory()
    const target = path.join(baseDir, 'successful-worktree')
    const sentinel = path.join(target, 'checked-out-file.txt')
    await fs.mkdir(target)
    await fs.writeFile(sentinel, 'must survive')

    await expect(removeEmptyWorktreeDirectory(target)).resolves.toBe(false)
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('must survive')
  })

  it('removes only an empty directory during failure cleanup', async () => {
    const baseDir = await temporaryDirectory()
    const target = path.join(baseDir, 'partial-worktree')
    await fs.mkdir(target)

    await expect(removeEmptyWorktreeDirectory(target)).resolves.toBe(true)
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
