import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GitWorktreeInfo } from '../shared/worktree-types.js'
import { inspectGitRepository, runGitCommand } from './git-review.js'

function gitError(stderr: string, fallback: string): Error {
  const firstLine = stderr.trim().split(/\r?\n/, 1)[0]
  return new Error(firstLine || fallback)
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function parseGitWorktrees(output: string, currentRoot: string): readonly GitWorktreeInfo[] {
  const blocks = output.trim().split(/\r?\n\r?\n/).filter(Boolean)
  return blocks.flatMap((block, index) => {
    const values = new Map<string, string>()
    const flags = new Set<string>()
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ')
      if (separator < 0) {
        flags.add(line)
      } else {
        values.set(line.slice(0, separator), line.slice(separator + 1))
      }
    }
    const worktreePath = values.get('worktree')
    if (!worktreePath) return []
    const branchRef = values.get('branch')
    return [{
      path: path.resolve(worktreePath),
      head: values.get('HEAD') ?? '',
      branch: branchRef?.replace(/^refs\/heads\//, ''),
      detached: flags.has('detached'),
      bare: flags.has('bare'),
      locked: values.has('locked') || flags.has('locked'),
      lockReason: values.get('locked'),
      isMain: index === 0,
      isCurrent: comparablePath(worktreePath) === comparablePath(currentRoot),
    }]
  })
}

export async function listGitWorktrees(workDir: string): Promise<readonly GitWorktreeInfo[]> {
  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  const result = await runGitCommand(snapshot.root, ['worktree', 'list', '--porcelain'])
  if (!result.ok) throw gitError(result.stderr, '无法读取 Git 工作树')
  return parseGitWorktrees(result.stdout, snapshot.root)
}

export async function resolveGitWorktree(
  workDir: string,
  requestedPath: string,
): Promise<GitWorktreeInfo> {
  if (!requestedPath || requestedPath.includes('\0')) throw new Error('工作树路径无效')
  const requested = comparablePath(requestedPath)
  const worktree = (await listGitWorktrees(workDir)).find(
    (candidate) => comparablePath(candidate.path) === requested,
  )
  if (!worktree) throw new Error('目标目录不在当前仓库的 Git 工作树列表中')
  return worktree
}

async function nextAvailablePath(baseDir: string, branchName: string): Promise<string> {
  const slug = branchName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'worktree'

  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const candidate = path.join(baseDir, suffix === 1 ? slug : `${slug}-${suffix}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('无法为工作树分配目录')
}

export async function createGitWorktree(
  workDir: string,
  storageRoot: string,
  branchName: string,
): Promise<GitWorktreeInfo> {
  const branch = branchName.trim()
  if (!branch) throw new Error('请输入工作树分支名称')

  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  const validBranch = await runGitCommand(snapshot.root, ['check-ref-format', '--branch', branch])
  if (!validBranch.ok) throw new Error('分支名称不符合 Git 规范')

  const commonDir = await runGitCommand(snapshot.root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (!commonDir.ok) throw gitError(commonDir.stderr, '无法定位 Git 公共目录')
  const repositoryRoot = path.dirname(commonDir.stdout.trim())
  const repositoryName = path.basename(repositoryRoot) || 'repository'
  const repositoryKey = createHash('sha256')
    .update(comparablePath(repositoryRoot))
    .digest('hex')
    .slice(0, 10)
  const baseDir = path.join(storageRoot, 'worktrees', `${repositoryName}-${repositoryKey}`)
  await fs.mkdir(baseDir, { recursive: true })
  const targetPath = await nextAvailablePath(baseDir, branch)

  const branchExists = await runGitCommand(snapshot.root, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ])
  const args = branchExists.ok
    ? ['worktree', 'add', targetPath, branch]
    : ['worktree', 'add', '-b', branch, targetPath, 'HEAD']
  const result = await runGitCommand(snapshot.root, args)
  if (!result.ok) {
    const relativeTarget = path.relative(baseDir, targetPath)
    if (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
    }
    throw gitError(result.stderr, '无法创建 Git 工作树')
  }

  const worktrees = await listGitWorktrees(targetPath)
  const created = worktrees.find(
    (candidate) => comparablePath(candidate.path) === comparablePath(targetPath),
  )
  if (!created) throw new Error('Git 已创建工作树，但无法从列表中读取它')
  return created
}
