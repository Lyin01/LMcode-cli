import { shell } from 'electron'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readFileAttachment,
  readInlineImageAttachment,
  readTextAttachment,
} from '../../file-attachment.js'
import type {
  FileAttachmentPreview,
  TextAttachment,
} from '../../../shared/file-types.js'
import {
  applyGitHunkAction,
  commitGitChanges,
  discardAllGitChanges,
  discardGitFileChanges,
  inspectGitFileDiff,
  inspectGitRepository,
  setAllGitFilesStaged,
  setGitFileStaged,
} from '../../git-review.js'
import {
  createGitWorktree,
  listGitWorktrees,
  resolveGitWorktree,
} from '../../git-worktree.js'
import type {
  GitCommitResult,
  GitDiscardScope,
  GitFileDiff,
  GitHunkActionInput,
  GitRepositorySnapshot,
} from '../../../shared/git-types.js'
import type { GitWorktreeInfo } from '../../../shared/worktree-types.js'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * File access and Git review/worktree surfaces. All operations resolve the
 * session's project directory on demand and reuse the main-side attachment
 * and git helpers.
 */
export function registerFilesGitHandlers(ctx: DesktopHandlerContext): void {
  const { secureInvoke } = ctx

  // ── File operations ─────────────────────────────────────────────

  secureInvoke('lmcode:readFileContent', async (_event, filePath: string): Promise<TextAttachment> => {
    return readTextAttachment(filePath, ctx.credentialRoots)
  })

  secureInvoke(
    'lmcode:readFileAttachment',
    async (_event, filePath: string): Promise<FileAttachmentPreview> => {
      return readFileAttachment(filePath, ctx.credentialRoots)
    },
  )

  secureInvoke(
    'lmcode:readInlineImageAttachment',
    async (_event, name: string, dataUrl: string): Promise<FileAttachmentPreview> => {
      return readInlineImageAttachment(name, dataUrl)
    },
  )

  // Model-produced paths are untrusted text. Only absolute local paths and
  // validated HTTPS URLs reach Electron's shell APIs; no command shell is used.
  secureInvoke('lmcode:openPath', async (_event, input: unknown): Promise<string> => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) {
      return typeof input !== 'string' || input.trim().length === 0 ? '路径为空' : '仅支持打开绝对路径'
    }
    return (await shell.openPath(target)) || ''
  })

  secureInvoke('lmcode:openExternal', async (_event, input: unknown): Promise<void> => {
    if (typeof input !== 'string' || input.length === 0) return
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return
    }
    if (url.protocol !== 'https:' || url.hostname.length === 0) return
    await shell.openExternal(url.href)
  })

  secureInvoke('lmcode:showItemInFolder', (_event, input: unknown): string => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) return '仅支持打开绝对路径'
    shell.showItemInFolder(target)
    return ''
  })

  secureInvoke('lmcode:openInVscode', (_event, input: unknown): string => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) return '仅支持打开绝对路径'
    const executable = resolveVscodeExecutable()
    if (executable === null) {
      return '未找到 VSCode（可用环境变量 LMCODE_VSCODE_PATH 指定 Code.exe 路径）'
    }
    const child = spawn(executable, [target], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return ''
  })

  // ── Git review ─────────────────────────────────────────────────

  secureInvoke(
    'lmcode:getGitSnapshot',
    async (_event, sessionId: string): Promise<GitRepositorySnapshot> => {
      return inspectGitRepository(await ctx.getSessionWorkDir(sessionId))
    },
  )

  secureInvoke(
    'lmcode:getGitFileDiff',
    async (_event, sessionId: string, filePath: string): Promise<GitFileDiff> => {
      return inspectGitFileDiff(await ctx.getSessionWorkDir(sessionId), filePath)
    },
  )

  secureInvoke(
    'lmcode:setGitFileStaged',
    async (
      _event,
      sessionId: string,
      filePath: string,
      staged: boolean,
    ): Promise<void> => {
      await setGitFileStaged(await ctx.getSessionWorkDir(sessionId), filePath, staged)
    },
  )

  secureInvoke(
    'lmcode:setAllGitFilesStaged',
    async (_event, sessionId: string, staged: boolean): Promise<void> => {
      await setAllGitFilesStaged(await ctx.getSessionWorkDir(sessionId), staged)
    },
  )

  secureInvoke(
    'lmcode:applyGitHunkAction',
    async (_event, sessionId: string, input: GitHunkActionInput): Promise<void> => {
      await applyGitHunkAction(await ctx.getSessionWorkDir(sessionId), input)
    },
  )

  secureInvoke(
    'lmcode:discardGitFileChanges',
    async (
      _event,
      sessionId: string,
      filePath: string,
      scope: GitDiscardScope,
    ): Promise<void> => {
      await discardGitFileChanges(
        await ctx.getSessionWorkDir(sessionId),
        filePath,
        scope,
        (target) => shell.trashItem(target),
      )
      ctx.auditLog?.info('desktop critical operation completed', {
        operation: 'git.discard-file',
      })
    },
  )

  secureInvoke(
    'lmcode:discardAllGitChanges',
    async (_event, sessionId: string): Promise<void> => {
      await discardAllGitChanges(
        await ctx.getSessionWorkDir(sessionId),
        (target) => shell.trashItem(target),
      )
      ctx.auditLog?.info('desktop critical operation completed', {
        operation: 'git.discard-all',
      })
    },
  )

  secureInvoke(
    'lmcode:commitGitChanges',
    async (_event, sessionId: string, message: string): Promise<GitCommitResult> => {
      const result = await commitGitChanges(await ctx.getSessionWorkDir(sessionId), message)
      ctx.auditLog?.info('desktop critical operation completed', {
        operation: 'git.commit',
      })
      return result
    },
  )

  // ── Git worktrees ───────────────────────────────────────────────

  secureInvoke(
    'lmcode:listGitWorktrees',
    async (_event, sessionId: string): Promise<readonly GitWorktreeInfo[]> => {
      return listGitWorktrees(await ctx.getSessionWorkDir(sessionId))
    },
  )

  secureInvoke(
    'lmcode:createWorktreeHandoff',
    async (
      _event,
      sessionId: string,
      branchName: string,
    ): Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }> => {
      const worktree = await createGitWorktree(
        await ctx.getSessionWorkDir(sessionId),
        ctx.harness.homeDir,
        branchName,
      )
      return { worktree, session: await ctx.forkSessionIntoWorktree(sessionId, worktree) }
    },
  )

  secureInvoke(
    'lmcode:handoffToWorktree',
    async (
      _event,
      sessionId: string,
      worktreePath: string,
    ): Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }> => {
      const worktree = await resolveGitWorktree(
        await ctx.getSessionWorkDir(sessionId),
        worktreePath,
      )
      return { worktree, session: await ctx.forkSessionIntoWorktree(sessionId, worktree) }
    },
  )
}

function normalizeOpenPathTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return null
  let target = trimmed
  if (trimmed.startsWith('file://')) {
    try {
      target = fileURLToPath(trimmed)
    } catch {
      return null
    }
  }
  return isAbsolute(target) ? target : null
}

/** Locate a native VSCode executable so Windows never needs a .cmd shim or shell. */
function resolveVscodeExecutable(): string | null {
  const candidates: string[] = []
  const override = process.env['LMCODE_VSCODE_PATH']
  if (override !== undefined && override.trim().length > 0) candidates.push(override.trim())
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'))
    candidates.push(join(localAppData, 'Programs', 'VSCodium', 'VSCodium.exe'))
  }
  for (const programFiles of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (programFiles !== undefined && programFiles.length > 0) {
      candidates.push(join(programFiles, 'Microsoft VS Code', 'Code.exe'))
    }
  }
  if (process.platform === 'win32' && typeof process.env['USERPROFILE'] === 'string') {
    candidates.push(join(process.env['USERPROFILE'], 'scoop', 'apps', 'vscode', 'current', 'Code.exe'))
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
