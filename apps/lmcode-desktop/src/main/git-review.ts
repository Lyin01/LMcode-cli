import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitChangeKind,
  GitCommitResult,
  GitDiscardScope,
  GitDiffSection,
  GitFileChange,
  GitFileDiff,
  GitHunkActionInput,
  GitRepositorySnapshot,
} from '../shared/git-types.js'

const GIT_COMMAND_TIMEOUT_MS = 15_000
const GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
const DIFF_PREVIEW_LIMIT_CHARS = 1_000_000
const UNTRACKED_PREVIEW_LIMIT_LINES = 5_000
// Untracked files are read fully into memory to build their preview patch, so
// refuse anything beyond this size up front instead of buffering it first.
export const UNTRACKED_PREVIEW_LIMIT_BYTES = 8 * 1024 * 1024

export interface GitCommandResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly errorMessage?: string
}

export function runGitCommand(workDir: string, args: readonly string[]): Promise<GitCommandResult> {
  return runGitCommandWithInput(workDir, args)
}

function runGitCommandWithInput(
  workDir: string,
  args: readonly string[],
  input?: string,
): Promise<GitCommandResult> {
  const deferred = Promise.withResolvers<GitCommandResult>()
  const child = execFile(
    'git',
    [...args],
    {
      cwd: workDir,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      deferred.resolve({
        ok: error === null,
        stdout,
        stderr,
        errorMessage: error?.message,
      })
    },
  )
  if (input !== undefined) {
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  }
  return deferred.promise
}

function changeKind(indexStatus: string, worktreeStatus: string): GitChangeKind {
  const statuses = `${indexStatus}${worktreeStatus}`
  if (statuses === '??') return 'untracked'
  if (statuses.includes('U') || statuses === 'AA' || statuses === 'DD') return 'unmerged'
  if (statuses.includes('R')) return 'renamed'
  if (statuses.includes('C')) return 'copied'
  if (statuses.includes('D')) return 'deleted'
  if (statuses.includes('A')) return 'added'
  if (statuses.includes('T')) return 'type-changed'
  if (statuses.includes('M')) return 'modified'
  return 'unknown'
}

export function parseGitStatus(output: string): readonly GitFileChange[] {
  const records = output.split('\0')
  const changes: GitFileChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue

    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    if (`${indexStatus}${worktreeStatus}` === '!!') continue

    const filePath = record.slice(3)
    const isRenameOrCopy =
      indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = isRenameOrCopy ? records[index + 1] || undefined : undefined
    if (isRenameOrCopy) index += 1

    changes.push({
      path: filePath,
      originalPath,
      kind: changeKind(indexStatus, worktreeStatus),
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ',
    })
  }

  return changes
}

function userFacingGitError(result: GitCommandResult): string {
  const detail = result.stderr.trim() || result.errorMessage || 'Git 命令执行失败'
  if (/not a git repository/i.test(detail)) return '当前项目不是 Git 仓库'
  if (/ENOENT|not recognized|cannot find/i.test(detail)) return '系统中未找到 Git'
  return detail.split(/\r?\n/, 1)[0] ?? 'Git 命令执行失败'
}

async function readBranch(root: string): Promise<{
  readonly branch?: string
  readonly detached: boolean
}> {
  const branch = await runGitCommand(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branch.ok) return { branch: branch.stdout.trim() || undefined, detached: false }

  const head = await runGitCommand(root, ['rev-parse', '--short', 'HEAD'])
  return {
    branch: head.ok ? `detached@${head.stdout.trim()}` : undefined,
    detached: true,
  }
}

async function readAheadBehind(root: string): Promise<{
  readonly ahead: number
  readonly behind: number
}> {
  const result = await runGitCommand(root, [
    'rev-list',
    '--left-right',
    '--count',
    'HEAD...@{upstream}',
  ])
  if (!result.ok) return { ahead: 0, behind: 0 }

  const [aheadText, behindText] = result.stdout.trim().split(/\s+/)
  return {
    ahead: Number.parseInt(aheadText ?? '0', 10) || 0,
    behind: Number.parseInt(behindText ?? '0', 10) || 0,
  }
}

export async function inspectGitRepository(workDir: string): Promise<GitRepositorySnapshot> {
  const rootResult = await runGitCommand(workDir, ['rev-parse', '--show-toplevel'])
  if (!rootResult.ok) {
    return {
      workDir,
      isRepository: false,
      detached: false,
      ahead: 0,
      behind: 0,
      changes: [],
      error: userFacingGitError(rootResult),
    }
  }

  const root = rootResult.stdout.trim()
  const [status, branch, upstream] = await Promise.all([
    runGitCommand(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    readBranch(root),
    readAheadBehind(root),
  ])
  if (!status.ok) {
    return {
      workDir,
      isRepository: true,
      root,
      branch: branch.branch,
      detached: branch.detached,
      ahead: upstream.ahead,
      behind: upstream.behind,
      changes: [],
      error: userFacingGitError(status),
    }
  }

  return {
    workDir,
    isRepository: true,
    root,
    branch: branch.branch,
    detached: branch.detached,
    ahead: upstream.ahead,
    behind: upstream.behind,
    changes: parseGitStatus(status.stdout),
  }
}

function limitPatch(patch: string): { readonly patch: string; readonly truncated: boolean } {
  if (patch.length <= DIFF_PREVIEW_LIMIT_CHARS) return { patch, truncated: false }
  return {
    patch: `${patch.slice(0, DIFF_PREVIEW_LIMIT_CHARS)}\n... diff 已截断 ...`,
    truncated: true,
  }
}

function displayPath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

async function createUntrackedPatch(root: string, filePath: string): Promise<GitDiffSection> {
  const absolutePath = path.resolve(root, filePath)
  const relativePath = path.relative(root, absolutePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('拒绝读取 Git 工作区之外的文件')
  }

  // The lexical check above is not enough: git status happily lists a symlink
  // as untracked, and readFile follows it — so a malicious repo could exfiltrate
  // any file outside the worktree into the diff preview (and from there into a
  // model prompt). Resolve the real path and re-check containment.
  const realRoot = await fs.realpath(root)
  const realPath = await fs.realpath(absolutePath)
  const realRelative = path.relative(realRoot, realPath)
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('拒绝读取 Git 工作区之外的文件')
  }
  const stat = await fs.lstat(absolutePath)
  if (stat.isSymbolicLink()) {
    return {
      kind: 'untracked',
      patch: `Symbolic link ${displayPath(filePath)} is untracked`,
      truncated: false,
    }
  }

  if (stat.size > UNTRACKED_PREVIEW_LIMIT_BYTES) {
    return {
      kind: 'untracked',
      patch: `File ${displayPath(filePath)} is untracked and too large to preview (${stat.size} bytes)`,
      truncated: true,
    }
  }

  const content = await fs.readFile(absolutePath)
  if (content.includes(0)) {
    return {
      kind: 'untracked',
      patch: `Binary file ${displayPath(filePath)} is untracked`,
      truncated: false,
    }
  }

  const text = content.toString('utf8')
  const allLines = text.split(/\r?\n/)
  const lines = allLines.slice(0, UNTRACKED_PREVIEW_LIMIT_LINES)
  const shownLineCount = lines.length
  const header = [
    `diff --git a/${displayPath(filePath)} b/${displayPath(filePath)}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${displayPath(filePath)}`,
    `@@ -0,0 +1,${shownLineCount} @@`,
  ]
  const rawPatch = [...header, ...lines.map((line) => `+${line}`)].join('\n')
  const limited = limitPatch(rawPatch)
  return {
    kind: 'untracked',
    patch: limited.patch,
    truncated: limited.truncated || allLines.length > lines.length,
  }
}

async function readDiffSection(
  root: string,
  filePath: string,
  kind: 'staged' | 'unstaged',
): Promise<GitDiffSection | undefined> {
  const patch = await readRawDiffPatch(root, filePath, kind)
  if (!patch.trim()) return undefined
  const limited = limitPatch(patch)
  return { kind, patch: limited.patch, truncated: limited.truncated }
}

async function readRawDiffPatch(
  root: string,
  filePath: string,
  kind: 'staged' | 'unstaged',
): Promise<string> {
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=3',
    ...(kind === 'staged' ? ['--cached'] : []),
    '--',
    filePath,
  ]
  const result = await runGitCommand(root, args)
  if (!result.ok) throw new Error(userFacingGitError(result))
  return result.stdout
}

export async function inspectGitFileDiff(
  workDir: string,
  filePath: string,
): Promise<GitFileDiff> {
  if (!filePath || filePath.includes('\0')) throw new Error('无效的 Git 文件路径')

  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  const change = snapshot.changes.find((candidate) => candidate.path === filePath)
  if (!change) throw new Error('该文件不在当前 Git 变更列表中')

  const sections: GitDiffSection[] = []
  if (change.staged) {
    const staged = await readDiffSection(snapshot.root, filePath, 'staged')
    if (staged) sections.push(staged)
  }
  if (change.unstaged && change.kind !== 'untracked') {
    const unstaged = await readDiffSection(snapshot.root, filePath, 'unstaged')
    if (unstaged) sections.push(unstaged)
  }
  if (change.kind === 'untracked') {
    sections.push(await createUntrackedPatch(snapshot.root, filePath))
  }

  return { path: filePath, sections }
}

async function resolveChange(
  workDir: string,
  filePath: string,
): Promise<{
  readonly root: string
  readonly change: GitFileChange
}> {
  if (!filePath || filePath.includes('\0')) throw new Error('无效的 Git 文件路径')
  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  const change = snapshot.changes.find((candidate) => candidate.path === filePath)
  if (!change) throw new Error('该文件不在当前 Git 变更列表中')
  return { root: snapshot.root, change }
}

export async function setGitFileStaged(
  workDir: string,
  filePath: string,
  staged: boolean,
): Promise<void> {
  const { root, change } = await resolveChange(workDir, filePath)
  const paths = change.originalPath ? [change.path, change.originalPath] : [change.path]
  if (staged && !change.unstaged) return
  if (!staged && !change.staged) return

  let result: GitCommandResult
  if (staged) {
    result = await runGitCommand(root, ['add', '-A', '--', ...paths])
  } else {
    result = await runGitCommand(root, ['restore', '--staged', '--', ...paths])
    if (!result.ok) {
      const hasHead = await runGitCommand(root, ['rev-parse', '--verify', 'HEAD'])
      if (!hasHead.ok) {
        result = await runGitCommand(root, ['rm', '--cached', '--ignore-unmatch', '--', ...paths])
      }
    }
  }

  if (!result.ok) throw new Error(userFacingGitError(result))
}

export async function setAllGitFilesStaged(
  workDir: string,
  staged: boolean,
): Promise<void> {
  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }

  let result: GitCommandResult
  if (staged) {
    result = await runGitCommand(snapshot.root, ['add', '-A', '--', '.'])
  } else {
    result = await runGitCommand(snapshot.root, ['restore', '--staged', '--', '.'])
    if (!result.ok) {
      const hasHead = await runGitCommand(snapshot.root, ['rev-parse', '--verify', 'HEAD'])
      if (!hasHead.ok) {
        result = await runGitCommand(snapshot.root, [
          'rm',
          '--cached',
          '-r',
          '--ignore-unmatch',
          '--',
          '.',
        ])
      }
    }
  }
  if (!result.ok) throw new Error(userFacingGitError(result))
}

function extractDiffHunk(patch: string, hunkIndex: number): string {
  if (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0) {
    throw new Error('无效的 diff hunk 索引')
  }
  const lines = patch.split('\n')
  const hunkStarts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('@@')) hunkStarts.push(index)
  }
  const start = hunkStarts[hunkIndex]
  const firstHunk = hunkStarts[0]
  if (start === undefined || firstHunk === undefined) {
    throw new Error('所选 diff hunk 已不存在，请刷新后重试')
  }
  const end = hunkStarts[hunkIndex + 1] ?? lines.length
  const extracted = [...lines.slice(0, firstHunk), ...lines.slice(start, end)].join('\n')
  return extracted.endsWith('\n') ? extracted : `${extracted}\n`
}

export async function applyGitHunkAction(
  workDir: string,
  input: GitHunkActionInput,
): Promise<void> {
  const { filePath, sectionKind, hunkIndex, action } = input
  if (
    !filePath ||
    filePath.includes('\0') ||
    (sectionKind !== 'staged' && sectionKind !== 'unstaged') ||
    !Number.isSafeInteger(hunkIndex) ||
    hunkIndex < 0
  ) {
    throw new Error('无效的 Git hunk 操作参数')
  }
  const actionAllowed =
    (sectionKind === 'unstaged' && (action === 'stage' || action === 'revert')) ||
    (sectionKind === 'staged' && action === 'unstage')
  if (!actionAllowed) throw new Error('该 diff 区域不支持此操作')

  const { root, change } = await resolveChange(workDir, filePath)
  if (sectionKind === 'staged' && !change.staged) {
    throw new Error('所选文件已没有暂存变更，请刷新后重试')
  }
  if (sectionKind === 'unstaged' && (!change.unstaged || change.kind === 'untracked')) {
    throw new Error('所选文件已没有可操作的工作区 hunk，请刷新后重试')
  }

  const rawPatch = await readRawDiffPatch(root, filePath, sectionKind)
  const hunkPatch = extractDiffHunk(rawPatch, hunkIndex)
  const args = ['apply', '--recount', '--whitespace=nowarn']
  if (action === 'stage') args.push('--cached')
  if (action === 'unstage') args.push('--cached', '--reverse')
  if (action === 'revert') args.push('--reverse')
  args.push('-')

  const result = await runGitCommandWithInput(root, args, hunkPatch)
  if (!result.ok) {
    const detail = userFacingGitError(result)
    throw new Error(`无法应用所选 hunk：${detail}`)
  }
}

export type TrashItem = (absolutePath: string) => Promise<void>

function resolveWorktreeEntry(root: string, filePath: string): string {
  const absolutePath = path.resolve(root, filePath)
  const relativePath = path.relative(root, absolutePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('拒绝操作 Git 工作区之外的文件')
  }
  return absolutePath
}

async function pathExistsInHead(root: string, filePath: string): Promise<boolean> {
  const result = await runGitCommand(root, [
    'cat-file',
    '-e',
    `HEAD:${displayPath(filePath)}`,
  ])
  return result.ok
}

async function trashWorkingTreeEntry(
  root: string,
  filePath: string,
  trashItem: TrashItem,
): Promise<void> {
  const absolutePath = resolveWorktreeEntry(root, filePath)
  const exists = await fs.lstat(absolutePath).then(() => true, () => false)
  if (exists) await trashItem(absolutePath)
}

export async function discardGitFileChanges(
  workDir: string,
  filePath: string,
  scope: GitDiscardScope,
  trashItem: TrashItem,
): Promise<void> {
  if (scope !== 'unstaged' && scope !== 'all') {
    throw new Error('无效的 Git 撤销范围')
  }
  const { root, change } = await resolveChange(workDir, filePath)
  const paths = change.originalPath ? [change.path, change.originalPath] : [change.path]

  if (change.kind === 'untracked') {
    await trashWorkingTreeEntry(root, change.path, trashItem)
    return
  }

  if (scope === 'unstaged') {
    if (!change.unstaged) return
    const result = await runGitCommand(root, ['restore', '--worktree', '--', ...paths])
    if (!result.ok) throw new Error(userFacingGitError(result))
    return
  }

  const hasTrackedSource = change.originalPath !== undefined ||
    await pathExistsInHead(root, change.path)
  if (!hasTrackedSource) {
    if (change.staged) {
      const unstage = await runGitCommand(root, [
        'rm',
        '--cached',
        '--ignore-unmatch',
        '--',
        change.path,
      ])
      if (!unstage.ok) throw new Error(userFacingGitError(unstage))
    }
    await trashWorkingTreeEntry(root, change.path, trashItem)
    return
  }

  const result = await runGitCommand(root, [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    ...paths,
  ])
  if (!result.ok) throw new Error(userFacingGitError(result))
}

export async function discardAllGitChanges(
  workDir: string,
  trashItem: TrashItem,
): Promise<void> {
  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  const paths = snapshot.changes.map((change) => change.path)
  for (const filePath of paths) {
    const current = await inspectGitRepository(workDir)
    if (!current.changes.some((change) => change.path === filePath)) continue
    await discardGitFileChanges(workDir, filePath, 'all', trashItem)
  }
}

export async function commitGitChanges(
  workDir: string,
  message: string,
): Promise<GitCommitResult> {
  const normalizedMessage = message.trim()
  if (!normalizedMessage) throw new Error('提交说明不能为空')
  if (normalizedMessage.length > 500 || normalizedMessage.includes('\0')) {
    throw new Error('提交说明无效或过长')
  }

  const snapshot = await inspectGitRepository(workDir)
  if (!snapshot.isRepository || !snapshot.root) {
    throw new Error(snapshot.error || '当前项目不是 Git 仓库')
  }
  if (!snapshot.changes.some((change) => change.staged)) {
    throw new Error('没有已暂存的变更可提交')
  }

  const result = await runGitCommand(snapshot.root, ['commit', '-m', normalizedMessage])
  if (!result.ok) throw new Error(userFacingGitError(result))

  const oidResult = await runGitCommand(snapshot.root, ['rev-parse', '--short', 'HEAD'])
  if (!oidResult.ok) throw new Error(userFacingGitError(oidResult))
  return {
    oid: oidResult.stdout.trim(),
    summary: result.stdout.trim().split(/\r?\n/, 1)[0] ?? normalizedMessage,
  }
}
