import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyGitHunkAction,
  commitGitChanges,
  discardAllGitChanges,
  discardGitFileChanges,
  inspectGitFileDiff,
  inspectGitRepository,
  setAllGitFilesStaged,
  setGitFileStaged,
  UNTRACKED_PREVIEW_LIMIT_BYTES,
} from '../src/main/git-review'

const temporaryDirectories: string[] = []
const GIT_INTEGRATION_TEST_TIMEOUT_MS = 30_000

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
      fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 5 : 0,
        retryDelay: 100,
      }),
    ),
  )
})

describe('desktop Git review', { timeout: GIT_INTEGRATION_TEST_TIMEOUT_MS }, () => {
  it('reports staged, unstaged, and untracked files with reviewable patches', async () => {
    const workDir = await createRepository()
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'staged.txt'), 'staged content\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'untracked.txt'), 'untracked content\n', 'utf8')
    git(workDir, 'add', 'staged.txt')

    const snapshot = await inspectGitRepository(workDir)

    expect(snapshot.isRepository).toBe(true)
    expect(snapshot.root).toBe((await fs.realpath(workDir)).replaceAll('\\', '/'))
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

  it('returns a placeholder patch for an oversized untracked file instead of reading it fully', async () => {
    const workDir = await createRepository()
    await fs.writeFile(
      path.join(workDir, 'huge.txt'),
      'x'.repeat(UNTRACKED_PREVIEW_LIMIT_BYTES + 4096),
      'utf8',
    )

    const diff = await inspectGitFileDiff(workDir, 'huge.txt')

    expect(diff.sections).toEqual([
      expect.objectContaining({
        kind: 'untracked',
        patch: expect.stringContaining('too large'),
        truncated: true,
      }),
    ])
    expect(diff.sections[0]?.patch.length ?? 0).toBeLessThan(1024)
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

  it('stages, unstages, and reverts one hunk without touching a separate hunk', async () => {
    const workDir = await createRepository()
    const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    await fs.writeFile(path.join(workDir, 'tracked.txt'), original, 'utf8')
    git(workDir, 'add', 'tracked.txt')
    git(
      workDir,
      '-c',
      'user.name=LMCODE Test',
      '-c',
      'user.email=lmcode@example.invalid',
      'commit',
      '-m',
      'expand fixture',
    )

    const changedLines = original.trimEnd().split('\n')
    changedLines[1] = 'line 2 changed'
    changedLines[14] = 'line 15 changed'
    await fs.writeFile(path.join(workDir, 'tracked.txt'), `${changedLines.join('\n')}\n`, 'utf8')

    await applyGitHunkAction(workDir, {
      filePath: 'tracked.txt',
      sectionKind: 'unstaged',
      hunkIndex: 0,
      action: 'stage',
    })
    const partlyStaged = await inspectGitRepository(workDir)
    expect(partlyStaged.changes).toEqual([
      expect.objectContaining({ path: 'tracked.txt', staged: true, unstaged: true }),
    ])
    const splitDiff = await inspectGitFileDiff(workDir, 'tracked.txt')
    expect(splitDiff.sections.find((section) => section.kind === 'staged')?.patch)
      .toContain('line 2 changed')
    expect(splitDiff.sections.find((section) => section.kind === 'unstaged')?.patch)
      .toContain('line 15 changed')

    await applyGitHunkAction(workDir, {
      filePath: 'tracked.txt',
      sectionKind: 'staged',
      hunkIndex: 0,
      action: 'unstage',
    })
    await applyGitHunkAction(workDir, {
      filePath: 'tracked.txt',
      sectionKind: 'unstaged',
      hunkIndex: 0,
      action: 'revert',
    })

    const content = (await fs.readFile(path.join(workDir, 'tracked.txt'), 'utf8'))
      .replaceAll('\r\n', '\n')
    expect(content).toContain('line 2\n')
    expect(content).not.toContain('line 2 changed')
    expect(content).toContain('line 15 changed')
  })

  it('stages and unstages the whole diff while preserving working files', async () => {
    const workDir = await createRepository()
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'new.txt'), 'new content\n', 'utf8')

    await setAllGitFilesStaged(workDir, true)
    const staged = await inspectGitRepository(workDir)
    expect(staged.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', staged: true, unstaged: false }),
        expect.objectContaining({ path: 'new.txt', staged: true, unstaged: false }),
      ]),
    )

    await setAllGitFilesStaged(workDir, false)
    const unstaged = await inspectGitRepository(workDir)
    expect(unstaged.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', staged: false, unstaged: true }),
        expect.objectContaining({ path: 'new.txt', kind: 'untracked', staged: false }),
      ]),
    )
    await expect(fs.readFile(path.join(workDir, 'new.txt'), 'utf8')).resolves.toBe('new content\n')
  })

  it('restores tracked changes and sends untracked files through the trash callback', async () => {
    const workDir = await createRepository()
    const untrackedPath = path.join(workDir, 'untracked.txt')
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'changed\n', 'utf8')
    await fs.writeFile(untrackedPath, 'recoverable\n', 'utf8')
    const canonicalUntrackedPath = await fs.realpath(untrackedPath)
    const trashed: string[] = []
    const trashItem = async (target: string): Promise<void> => {
      trashed.push(target)
      await fs.rm(target, { force: true })
    }

    await discardGitFileChanges(workDir, 'tracked.txt', 'unstaged', trashItem)
    const restored = await fs.readFile(path.join(workDir, 'tracked.txt'), 'utf8')
    expect(restored.replaceAll('\r\n', '\n')).toBe('before\n')
    expect(trashed).toEqual([])

    await discardGitFileChanges(workDir, 'untracked.txt', 'all', trashItem)
    expect(trashed).toEqual([canonicalUntrackedPath])
    await expect(fs.stat(untrackedPath)).rejects.toThrow()
  })

  it('discards the complete diff only through the supplied recoverable-trash boundary', async () => {
    const workDir = await createRepository()
    await fs.writeFile(path.join(workDir, 'tracked.txt'), 'changed\n', 'utf8')
    await fs.writeFile(path.join(workDir, 'new.txt'), 'new\n', 'utf8')
    git(workDir, 'add', 'tracked.txt')
    const trashed: string[] = []

    await discardAllGitChanges(workDir, async (target) => {
      trashed.push(path.basename(target))
      await fs.rm(target, { force: true })
    })

    await expect(inspectGitRepository(workDir)).resolves.toEqual(
      expect.objectContaining({ changes: [] }),
    )
    expect(trashed).toEqual(['new.txt'])
    const restored = await fs.readFile(path.join(workDir, 'tracked.txt'), 'utf8')
    expect(restored.replaceAll('\r\n', '\n')).toBe('before\n')
  })
})
