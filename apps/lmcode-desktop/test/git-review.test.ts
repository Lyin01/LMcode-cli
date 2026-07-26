import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitGitChanges,
  inspectGitFileDiff,
  inspectGitRepository,
  setGitFileStaged,
} from '../src/main/git-review'

const temporaryDirectories: string[] = []

function git(workDir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'ignore', windowsHide: true })
}

async function createRepository(): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-git-review-'))
  temporaryDirectories.push(workDir)
  git(workDir, 'init')
  await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\n', 'utf8')
  git(workDir, 'add', 'tracked.txt')
  git(
    workDir,
    '-c',
    'user.name=LMCODE Test',
    '-c',
    'user.email=lmcode@example.invalid',
    'commit',
    '-m',
    'initial',
  )
  return workDir
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('desktop Git review', () => {
  it('reports staged, unstaged, and untracked files with reviewable patches', async () => {
    const workDir = await createRepository()
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'staged.txt'), 'staged content\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'untracked.txt'), 'untracked content\n', 'utf8')
    git(workDir, 'add', 'staged.txt')

    const snapshot = await inspectGitRepository(workDir)

    expect(snapshot.isRepository).toBe(true)
    expect(snapshot.root).toBe(workDir.replaceAll('\\', '/'))
    expect(snapshot.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'staged.txt', kind: 'added', staged: true }),
        expect.objectContaining({ path: 'tracked.txt', kind: 'modified', unstaged: true }),
        expect.objectContaining({ path: 'untracked.txt', kind: 'untracked', unstaged: true }),
      ]),
    )

    const staged = await inspectGitFileDiff(workDir, 'staged.txt')
    const unstaged = await inspectGitFileDiff(workDir, 'tracked.txt')
    const untracked = await inspectGitFileDiff(workDir, 'untracked.txt')

    expect(staged.sections).toEqual([
      expect.objectContaining({ kind: 'staged', patch: expect.stringContaining('+staged content') }),
    ])
    expect(unstaged.sections).toEqual([
      expect.objectContaining({ kind: 'unstaged', patch: expect.stringContaining('+after') }),
    ])
    expect(untracked.sections).toEqual([
      expect.objectContaining({ kind: 'untracked', patch: expect.stringContaining('+untracked content') }),
    ])
  })

  it('returns a user-facing non-repository state instead of throwing', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-not-git-'))
    temporaryDirectories.push(workDir)

    await expect(inspectGitRepository(workDir)).resolves.toEqual(
      expect.objectContaining({
        workDir,
        isRepository: false,
        changes: [],
        error: '当前项目不是 Git 仓库',
      }),
    )
  })

  it('stages, unstages, and commits a selected file without changing its working content', async () => {
    const workDir = await createRepository()
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n', 'utf8')

    await setGitFileStaged(workDir, 'tracked.txt', true)
    await expect(inspectGitRepository(workDir)).resolves.toEqual(
      expect.objectContaining({
        changes: [expect.objectContaining({ path: 'tracked.txt', staged: true, unstaged: false })],
      }),
    )

    await setGitFileStaged(workDir, 'tracked.txt', false)
    await expect(fs.readFile(path.join(workDir, 'tracked.txt'), 'utf8')).resolves.toBe(
      'before\nafter\n',
    )
    await expect(inspectGitRepository(workDir)).resolves.toEqual(
      expect.objectContaining({
        changes: [expect.objectContaining({ path: 'tracked.txt', staged: false, unstaged: true })],
      }),
    )

    git(workDir, 'config', 'user.name', 'LMCODE Test')
    git(workDir, 'config', 'user.email', 'lmcode@example.invalid')
    await setGitFileStaged(workDir, 'tracked.txt', true)
    await expect(commitGitChanges(workDir, 'Update tracked file')).resolves.toEqual({
      oid: expect.stringMatching(/^[0-9a-f]+$/),
      summary: expect.stringContaining('Update tracked file'),
    })
    await expect(inspectGitRepository(workDir)).resolves.toEqual(
      expect.objectContaining({ changes: [] }),
    )
  })
})
