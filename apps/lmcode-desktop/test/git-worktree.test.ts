import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGitWorktree,
  listGitWorktrees,
  resolveGitWorktree,
} from '../src/main/git-worktree'

const temporaryDirectories: string[] = []

function git(workDir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

async function createRepository(): Promise<{
  readonly root: string
  readonly repository: string
  readonly storage: string
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-worktree-'))
  temporaryDirectories.push(root)
  const repository = path.join(root, 'repository')
  const storage = path.join(root, 'desktop-data')
  await fs.mkdir(repository)
  git(repository, 'init')
  await fs.writeFile(path.join(repository, 'README.md'), '# worktree test\n', 'utf8')
  git(repository, 'add', 'README.md')
  git(
    repository,
    '-c',
    'user.name=LMCODE Test',
    '-c',
    'user.email=lmcode@example.invalid',
    'commit',
    '-m',
    'initial',
  )
  return { root, repository, storage }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('desktop Git worktrees', () => {
  it('creates an isolated branch and returns it as the current worktree', async () => {
    const { repository, storage } = await createRepository()
    const initial = await listGitWorktrees(repository)

    const created = await createGitWorktree(repository, storage, 'lmcode/worktree-test')

    expect(initial).toHaveLength(1)
    expect(initial[0]).toEqual(expect.objectContaining({ isMain: true, isCurrent: true }))
    expect(created).toEqual(
      expect.objectContaining({
        branch: 'lmcode/worktree-test',
        isMain: false,
        isCurrent: true,
      }),
    )
    expect((await fs.stat(created.path)).isDirectory()).toBe(true)
    expect(git(created.path, 'branch', '--show-current')).toBe('lmcode/worktree-test')
    expect(await listGitWorktrees(repository)).toHaveLength(2)
    await expect(resolveGitWorktree(repository, created.path)).resolves.toEqual(
      expect.objectContaining({ path: created.path, branch: created.branch }),
    )
    await expect(resolveGitWorktree(repository, storage)).rejects.toThrow('工作树列表')
  })

  it('rejects invalid branch names before creating a directory', async () => {
    const { repository, storage } = await createRepository()

    await expect(createGitWorktree(repository, storage, 'bad branch name')).rejects.toThrow(
      '分支名称不符合 Git 规范',
    )
    await expect(fs.access(path.join(storage, 'worktrees'))).rejects.toBeDefined()
  })
})
