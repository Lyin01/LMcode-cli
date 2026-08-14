import { shell } from 'electron'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
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
