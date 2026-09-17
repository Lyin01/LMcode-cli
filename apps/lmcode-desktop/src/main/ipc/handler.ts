import { app, ipcMain, BrowserWindow, dialog, Notification, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { MemoryMemoStore } from '@lmcode/memory'
import type { MemoryMemoSummary } from '@lmcode/memory'
import type {
  Session,
  Event,
  LmcodeHarness,
  ApprovalResponse,
  QuestionResult,
  SessionSummary,
  ResumedSessionState,
  LmcodeConfig,
  LmcodeConfigPatch,
  GoalSnapshotData,
  CronJobInfo,
  BackgroundTaskInfo,
  SessionStatus,
  ComputerUseStatus,
  Logger,
} from '@lmcode-cli/lmcode-sdk'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isUnsafeShellOpenPath,
  normalizeOpenPathTarget,
  safeDirectoryDialogPath,
  safeSaveFileName,
} from '../../shared/open-path-guard.js'
import { isSafeExternalHttpsUrl } from '../../shared/security.js'
import type { RemoteFirewallStatus, RemoteState } from '../../shared/remote-types.js'
import { getRemoteFirewallStatus, repairRemoteFirewall } from '../remote/firewall.js'
import { getComputerUseDriverInfo, installComputerUseDriver } from '../computer-use.js'
import type {
  ComputerUseDriverInfo,
  ComputerUseInstallResult,
} from '../../shared/computer-use-types.js'
import type {
  DesktopCreateSessionOptions,
  DesktopNotificationPayload,
} from '../../shared/ipc-types.js'
import type {
  GitCommitResult,
  GitDiscardScope,
  GitFileDiff,
  GitHunkActionInput,
  GitRepositorySnapshot,
} from '../../shared/git-types.js'
import type { ProjectTerminalInfo, TerminalOutputPayload } from '../../shared/terminal-types.js'
import type { GitWorktreeInfo } from '../../shared/worktree-types.js'
import {
  applyGitHunkAction,
  commitGitChanges,
  discardAllGitChanges,
  discardGitFileChanges,
  inspectGitFileDiff,
  inspectGitRepository,
  setAllGitFilesStaged,
  setGitFileStaged,
} from '../git-review.js'
import {
  createGitWorktree,
  listGitWorktrees,
  resolveGitWorktree,
} from '../git-worktree.js'
import { ProjectTerminalManager } from '../project-terminal.js'
import { isTrustedIpcSender } from '../security.js'
import { checkShellOpenTarget } from '../shell-open-target.js'
import {
  InteractionHub,
  type InteractionSurface,
} from '../remote/interaction-hub.js'
import {
  buildDesktopPromptInput,
  readFileAttachment,
  readInlineImageAttachment,
  readTextAttachment,
} from '../file-attachment.js'
import type {
  DesktopPromptRequest,
  FileAttachmentPreview,
  TextAttachment,
} from '../../shared/file-types.js'
import { resumeScheduledSessions, scheduledSessionIds } from '../scheduled-sessions.js'
import {
  restoreRedactedConfigPatch,
  sanitizeConfigForRenderer,
} from '../config-security.js'
import { ProviderUsageService } from '../provider-usage.js'
import { isPermissionMode } from '../../shared/permission-mode.js'
import type { ProviderUsageSnapshot } from '../../shared/provider-usage-types.js'
import {
  activateSkillArgsSchema,
  addMcpServerArgsSchema,
  applyGitHunkActionArgsSchema,
  compactSessionArgsSchema,
  commitGitChangesArgsSchema,
  createCronJobArgsSchema,
  createGoalArgsSchema,
  createSessionArgsSchema,
  discardGitFileChangesArgsSchema,
  filePathArgsSchema,
  idArgsSchema,
  inlineImageArgsSchema,
  optionalBooleanArgsSchema,
  optionalStringArgsSchema,
  parseIpcArgs,
  promptArgsSchema,
  renameSessionArgsSchema,
  respondApprovalArgsSchema,
  respondQuestionArgsSchema,
  saveTextFileArgsSchema,
  searchMemoriesArgsSchema,
  sessionNamedArgsSchema,
  setAllGitFilesStagedArgsSchema,
  setConfigArgsSchema,
  setGitFileStagedArgsSchema,
  setModelArgsSchema,
  setPermissionArgsSchema,
  setPlanModeArgsSchema,
  setRemoteEnabledArgsSchema,
  setRemotePortArgsSchema,
  setThinkingArgsSchema,
  undoHistoryArgsSchema,
  updateGoalStatusArgsSchema,
  worktreeHandoffArgsSchema,
  writeTerminalArgsSchema,
  openExternalArgsSchema,
  openPathArgsSchema,
  sessionIdArgsSchema,
  setComputerUseEnabledArgsSchema,
} from '../../shared/ipc-schemas.js'

interface SessionEntry {
  session: Session
  unsubscribeEvent: () => void
}

export interface DesktopHandlerRegistration {
  close(): Promise<void>
  invalidateProviderUsage(): void
}

/**
 * Remote-service control surface used by the settings panel. Implemented by
 * `RemoteManager`; defined as an interface so the IPC layer never depends on
 * the manager's implementation details.
 */
export interface RemoteController {
  getState(): RemoteState
  setEnabled(enabled: boolean): Promise<RemoteState>
  setPort(port: number): Promise<RemoteState>
  regenerateToken(): Promise<RemoteState>
  dropSession(sessionId: string): void
  setHostReleaseSession(handler: (sessionId: string) => Promise<void>): void
}

/**
 * Send a desktop notification (approval request, task completed, etc.)
 */
function sendNotification(title: string, body: string, mainWindow?: BrowserWindow): void {
  const focused =
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    typeof mainWindow.isFocused === 'function' &&
    mainWindow.isFocused()
  if (focused) return
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const wins = BrowserWindow.getAllWindows()
      const firstWindow = wins[0]
      if (firstWindow !== undefined) {
        firstWindow.show()
        firstWindow.focus()
      }
    })
    notification.show()
  }
}

/**
 * Register all IPC handlers for the LMCODE desktop app.
 */
export function registerAllHandlers(
  harness: LmcodeHarness,
  mainWindow: BrowserWindow,
  trustedRendererUrl: string,
  logger: Logger | undefined = undefined,
  noProjectWorkDir: string | undefined = undefined,
  hub: InteractionHub = new InteractionHub(),
  remote: RemoteController | undefined = undefined,
  memoryStore: MemoryMemoStore | undefined = undefined,
): DesktopHandlerRegistration {
  const invokeChannels: string[] = []
  const eventListeners: Array<{
    readonly channel: string
    readonly listener: (event: IpcMainEvent, ...args: unknown[]) => void
  }> = []
  const activeSessions = new Map<string, SessionEntry>()
  const credentialRoots = [harness.homeDir, dirname(harness.configPath)]

  // The renderer is the primary interaction surface. Remote clients attach
  // their own surface so approvals/questions reach every UI that is watching
  // the session; the first responder settles the request.
  const rendererSurface: InteractionSurface = {
    name: 'renderer',
    sendApproval: (payload) => {
      if (closing || mainWindow.isDestroyed()) return false
      try {
        sendNotification(
          'LMCODE - 审批请求',
          `需要审批：${payload.request.action || '执行操作'}`,
          mainWindow,
        )
        mainWindow.webContents.send('lmcode:approvalRequest', payload)
        return true
      } catch {
        return false
      }
    },
    sendQuestion: (payload) => {
      if (mainWindow.isDestroyed()) return false
      try {
        mainWindow.webContents.send('lmcode:questionRequest', payload)
        return true
      } catch {
        return false
      }
    },
    notifySettled: (payload) => {
      if (mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.send('lmcode:interactionSettled', payload)
      } catch {
        // Renderer teardown can race the destroyed check.
      }
    },
  }
  // Idempotent: replace any surface previously registered under this name
  // (a recreated window re-registers while the old registration may still be
  // draining its cleanup).
  hub.detachSurface('renderer')
  hub.attachSurface(rendererSurface)
  const auditLog = logger?.createChild({ surface: 'desktop-ipc' })
  const providerUsage = new ProviderUsageService({ loadConfig: () => harness.getConfig() })
  let closing = false
  let closePromise: Promise<void> | undefined
  const terminalManager = new ProjectTerminalManager((payload: TerminalOutputPayload) => {
    if (closing || mainWindow.isDestroyed()) return
    try {
      mainWindow.webContents.send('lmcode:terminalOutput', payload)
    } catch {
      // Renderer teardown can race the destroyed check.
    }
  })

  // The no-project sentinel directory is resolved by the main process only.
  // The renderer can ask for it (to recognize such sessions) but can never
  // steer it — `noProject` session requests never accept a caller path.
  function resolveNoProjectWorkDir(): string {
    if (noProjectWorkDir) return noProjectWorkDir
    const homeDir = harness.homeDir
    if (typeof homeDir === 'string' && homeDir.trim().length > 0) {
      return join(homeDir, 'no-project-workspace')
    }
    throw new Error('The no-project workspace directory is not configured')
  }

  /** Set up event forwarding and reverse-RPC handlers for one live session. */
  function setupSessionListeners(session: Session): void {
    if (closing) throw new Error('Desktop IPC registration is closed')

    // Idempotent: replace any listener previously registered by this window.
    const prior = activeSessions.get(session.id)
    if (prior) {
      prior.unsubscribeEvent()
      activeSessions.delete(session.id)
      hub.settleSession(session.id)
    }

    const unsubscribeEvent = session.onEvent((event: Event) => {
      if (!closing && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('lmcode:sessionEvent', {
            sessionId: session.id,
            event,
          })
        } catch {
          // Renderer teardown can race the destroyed check.
        }
      }
    })

    hub.bindSession(session)

    activeSessions.set(session.id, { session, unsubscribeEvent })
  }

  function secureInvoke<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
    schema?: Parameters<typeof parseIpcArgs>[0],
  ): void {
    ipcMain.handle(channel, async (event, ...args) => {
      if (closing) throw new Error(`Desktop IPC registration is closed on "${channel}"`)
      if (!isTrustedIpcSender(event, mainWindow.webContents, trustedRendererUrl)) {
        throw new Error(`Rejected IPC from an untrusted renderer on "${channel}"`)
      }
      const parsed = (schema === undefined ? args : parseIpcArgs(schema, args, channel)) as Args
      try {
        return await listener(event, ...parsed)
      } catch (error) {
        auditLog?.warn('desktop IPC operation failed', {
          channel,
          errorKind: error instanceof Error ? 'error' : typeof error,
        })
        throw error
      }
    })
    invokeChannels.push(channel)
  }

  function secureOn<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (closing) return
      if (!isTrustedIpcSender(event, mainWindow.webContents, trustedRendererUrl)) return
      try {
        listener(event, ...(args as Args))
      } catch (error) {
        // A throwing listener must not surface as an uncaught main-process
        // exception (Electron would tear the app down mid-stream).
        auditLog?.warn('desktop IPC listener failed', {
          channel,
          errorKind: error instanceof Error ? 'error' : typeof error,
        })
      }
    }
    ipcMain.on(channel, wrapped)
    eventListeners.push({ channel, listener: wrapped })
  }

  // Sessions selected in the UI are not necessarily "live" in the main process
  // (e.g. a persisted session picked after restart was never resumed). Resume it
  // on demand so prompting / model changes always hit a real Session.
  //
  // This MUST be race-safe: when a session becomes active the renderer fires
  // several IPC calls concurrently (load history, apply thinking level, …). Each
  // awaits `harness.resumeSession`, so a naive check-then-resume lets two callers
  // both see "not active" and both call `setupSessionListeners`, registering the
  // event forwarder twice — every event then reaches the renderer twice and the
  // streamed reply renders with every token duplicated. Dedupe in-flight resumes
  // by caching the promise.
  const resumingSessions = new Map<string, Promise<SessionEntry>>()
  const tearingDownSessions = new Map<string, Promise<void>>()

  async function ensureActiveSession(sessionId: string): Promise<SessionEntry> {
    if (closing) throw new Error('Desktop IPC registration is closed')
    if (tearingDownSessions.has(sessionId)) {
      throw new Error(`Session "${sessionId}" is closing`)
    }
    const existing = activeSessions.get(sessionId)
    if (existing !== undefined && !existing.session.isClosed) return existing
    if (existing) {
      existing.unsubscribeEvent()
      activeSessions.delete(sessionId)
    }

    const inflight = resumingSessions.get(sessionId)
    if (inflight) return inflight

    const pending = (async (): Promise<SessionEntry> => {
      const session = await harness.resumeSession({ id: sessionId })
      if (closing) throw new Error('Desktop IPC registration is closed')
      setupSessionListeners(session)
      const entry = activeSessions.get(sessionId)
      if (!entry) throw new Error(`Session "${sessionId}" not found`)
      return entry
    })()
    resumingSessions.set(sessionId, pending)
    try {
      return await pending
    } finally {
      resumingSessions.delete(sessionId)
    }
  }

  async function releaseLocalSession(sessionId: string): Promise<void> {
    await terminalManager.stop(sessionId)
    const entry = activeSessions.get(sessionId)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(sessionId)
      try {
        entry.session.setApprovalHandler(undefined)
        entry.session.setQuestionHandler(undefined)
      } catch {
        // Session may already be closed by a remote teardown.
      }
    }
    hub.settleSession(sessionId)
  }

  type TeardownKind = 'close' | 'delete'
  const teardownKind = new Map<string, TeardownKind>()

  function finishTeardown(sessionId: string, run: Promise<void>): void {
    if (tearingDownSessions.get(sessionId) === run) {
      tearingDownSessions.delete(sessionId)
      teardownKind.delete(sessionId)
    }
  }

  async function teardownSession(
    sessionId: string,
    kind: TeardownKind,
    work: () => Promise<void>,
  ): Promise<void> {
    const existing = tearingDownSessions.get(sessionId)
    if (existing !== undefined) {
      const currentKind = teardownKind.get(sessionId)
      // Close-then-delete used to wait for close and drop the delete, leaving
      // the session on disk. Upgrade the in-flight teardown to the stronger
      // operation. Delete-then-close just waits — the session is already going.
      if (kind === 'delete' && currentKind === 'close') {
        teardownKind.set(sessionId, 'delete')
        const chained = existing.then(work, work)
        tearingDownSessions.set(sessionId, chained)
        try {
          await chained
        } finally {
          finishTeardown(sessionId, chained)
        }
        return
      }
      await existing
      return
    }
    teardownKind.set(sessionId, kind)
    const run = (async () => {
      const inflightResume = resumingSessions.get(sessionId)
      if (inflightResume) await inflightResume.catch(() => undefined)
      await releaseLocalSession(sessionId)
      try {
        await work()
      } finally {
        remote?.dropSession(sessionId)
        hub.settleSession(sessionId)
      }
    })()
    tearingDownSessions.set(sessionId, run)
    try {
      await run
    } finally {
      finishTeardown(sessionId, run)
    }
  }

  async function getSessionWorkDir(sessionId: string): Promise<string> {
    const entry = await ensureActiveSession(sessionId)
    const workDir = entry.session.summary?.workDir
    if (!workDir) throw new Error(`Session "${sessionId}" has no project directory`)
    return workDir
  }

  async function forkSessionIntoWorktree(
    sessionId: string,
    worktree: GitWorktreeInfo,
  ): Promise<SessionSummary> {
    const source = await ensureActiveSession(sessionId)
    const branchLabel = worktree.branch ?? worktree.head.slice(0, 8)
    const sourceTitle = source.session.summary?.title?.trim()
    const fork = await harness.forkSession({
      id: sessionId,
      workDir: worktree.path,
      title: sourceTitle ? `${sourceTitle} · ${branchLabel}` : undefined,
      metadata: {
        desktopWorktree: {
          branch: branchLabel,
          path: worktree.path,
          sourceSessionId: sessionId,
        },
      },
    })
    setupSessionListeners(fork)
    if (!fork.summary) throw new Error('工作树会话已创建，但缺少会话摘要')
    return fork.summary
  }

  // ── Session management ──────────────────────────────────────────

  secureInvoke('lmcode:createSession', async (_event, opts: DesktopCreateSessionOptions): Promise<SessionSummary> => {
    const requestedWorkDir = opts.workDir?.trim() ?? ''
    if (opts.noProject === true && requestedWorkDir) {
      throw new Error('A no-project session cannot also specify a project directory')
    }
    const workDir = opts.noProject === true ? resolveNoProjectWorkDir() : requestedWorkDir
    if (!workDir) {
      throw new Error('A project directory is required to create a desktop session')
    }
    const session = await harness.createSession({
      workDir,
      model: opts.model,
      thinking: opts.thinking,
      permission: opts.permission,
    })
    setupSessionListeners(session)
    if (!session.summary) {
      throw new Error('The desktop session was created without a summary')
    }
    auditLog?.info('desktop critical operation completed', {
      operation: 'session.create',
    })
    return session.summary
  }, createSessionArgsSchema)

  secureInvoke(
    'lmcode:selectWorkDirectory',
    async (_event, initialDirectory?: string): Promise<string | undefined> => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 LMCODE 项目文件夹',
        defaultPath: safeDirectoryDialogPath(initialDirectory, app.getPath('home')),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled) return undefined
      return result.filePaths[0]
    },
    optionalStringArgsSchema,
  )

  secureInvoke('lmcode:resumeSession', async (_event, id: string): Promise<{
    summary: SessionSummary
    resumeState: ResumedSessionState | undefined
  }> => {
    const { session } = await ensureActiveSession(id)
    if (!session.summary) {
      throw new Error(`Session "${id}" resumed without a summary`)
    }
    return {
      summary: session.summary,
      resumeState: session.getResumeState(),
    }
  }, sessionIdArgsSchema)

  secureInvoke('lmcode:deleteSession', async (_event, id: string): Promise<void> => {
    await teardownSession(id, 'delete', async () => {
      await harness.deleteSession(id)
      auditLog?.info('desktop critical operation completed', {
        operation: 'session.delete',
      })
    })
  }, sessionIdArgsSchema)

  secureInvoke('lmcode:exportSession', async (_event, id: string): Promise<string> => {
    const result = await harness.exportSession({ id, version: app.getVersion() })
    return result.zipPath
  }, sessionIdArgsSchema)

  secureInvoke(
    'lmcode:saveTextFile',
    async (
      _event,
      input: { readonly suggestedName: string; readonly content: string },
    ): Promise<string | null> => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出为文件',
        defaultPath: safeSaveFileName(input.suggestedName),
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, input.content, 'utf8')
      return result.filePath
    },
    saveTextFileArgsSchema,
  )

  secureInvoke('lmcode:listSessions', async (): Promise<readonly SessionSummary[]> => {
    return harness.listSessions()
  })

  secureInvoke('lmcode:renameSession', async (_event, id: string, title: string): Promise<void> => {
    await harness.renameSession({ id, title })
  }, renameSessionArgsSchema)

  // ── Chat ────────────────────────────────────────────────────────

  secureInvoke(
    'lmcode:sendMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.prompt(await buildDesktopPromptInput(request, credentialRoots))
    },
    promptArgsSchema,
  )

  secureInvoke(
    'lmcode:steerMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.steer(await buildDesktopPromptInput(request, credentialRoots))
    },
    promptArgsSchema,
  )

  secureInvoke('lmcode:cancelResponse', async (_event, sessionId: string): Promise<void> => {
    hub.settleSession(sessionId)
    const teardown = tearingDownSessions.get(sessionId)
    if (teardown !== undefined) {
      await teardown.catch(() => undefined)
      return
    }
    const inflightResume = resumingSessions.get(sessionId)
    if (inflightResume) await inflightResume.catch(() => undefined)
    if (tearingDownSessions.has(sessionId)) return
    const entry = activeSessions.get(sessionId)
    if (!entry) return
    try {
      await entry.session.cancel()
    } finally {
      hub.settleSession(sessionId)
    }
  }, sessionIdArgsSchema)

  // Return the persisted conversation history so the UI can re-render a session's
  // messages after a restart or when switching back to it.
  secureInvoke('lmcode:getSessionHistory', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    const ctx = await entry.session.getContext()
    return ctx.history
  }, sessionIdArgsSchema)

  secureInvoke(
    'lmcode:getSessionStatus',
    async (_event, sessionId: string): Promise<SessionStatus> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getStatus()
    },
    sessionIdArgsSchema,
  )

  // ── Session control ─────────────────────────────────────────────

  secureInvoke('lmcode:setModel', async (_event, sessionId: string, model: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setModel(model)
  }, setModelArgsSchema)

  secureInvoke('lmcode:setThinking', async (_event, sessionId: string, level: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setThinking(level)
  }, setThinkingArgsSchema)

  secureInvoke(
    'lmcode:setPermission',
    async (_event, sessionId: string, mode: unknown): Promise<void> => {
      if (!isPermissionMode(mode)) throw new Error('Invalid permission mode')
      const entry = await ensureActiveSession(sessionId)
      await entry.session.setPermission(mode)
    },
    setPermissionArgsSchema,
  )

  secureInvoke(
    'lmcode:createGoal',
    async (
      _event,
      sessionId: string,
      objective: string,
      replace: boolean,
    ): Promise<GoalSnapshotData> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.createGoal(objective, { replace })
    },
    createGoalArgsSchema,
  )

  secureInvoke(
    'lmcode:getGoal',
    async (_event, sessionId: string): Promise<{ readonly goal: GoalSnapshotData | null }> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getGoal()
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:updateGoalStatus',
    async (
      _event,
      sessionId: string,
      status: 'active' | 'complete' | 'paused' | 'blocked',
    ): Promise<GoalSnapshotData | null> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.updateGoalStatus(status)
    },
    updateGoalStatusArgsSchema,
  )

  secureInvoke(
    'lmcode:cancelGoal',
    async (_event, sessionId: string): Promise<GoalSnapshotData | null> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.cancelGoal()
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:setPlanMode',
    async (_event, sessionId: string, enabled: boolean): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.setPlanMode(enabled)
    },
    setPlanModeArgsSchema,
  )

  secureInvoke(
    'lmcode:compactSession',
    async (_event, sessionId: string, instruction?: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.compact({ instruction })
    },
    compactSessionArgsSchema,
  )

  secureInvoke(
    'lmcode:undoHistory',
    async (_event, sessionId: string, count: number): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.undoHistory(count)
    },
    undoHistoryArgsSchema,
  )

  secureInvoke('lmcode:closeSession', async (_event, sessionId: string): Promise<void> => {
    await teardownSession(sessionId, 'close', async () => {
      await harness.closeSession(sessionId)
    })
  }, sessionIdArgsSchema)

  // ── Scheduled automations ──────────────────────────────────────

  secureInvoke(
    'lmcode:listCronJobs',
    async (_event, sessionId: string): Promise<readonly CronJobInfo[]> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.listCronJobs()
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:createCronJob',
    async (
      _event,
      sessionId: string,
      input: {
        readonly cron: string
        readonly prompt: string
        readonly recurring?: boolean | undefined
      },
    ): Promise<CronJobInfo> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.createCronJob(input)
    },
    createCronJobArgsSchema,
  )

  secureInvoke(
    'lmcode:deleteCronJob',
    async (_event, sessionId: string, id: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.deleteCronJob(id)
    },
    sessionNamedArgsSchema,
  )

  secureInvoke(
    'lmcode:listBackgroundTasks',
    async (_event, sessionId: string): Promise<readonly BackgroundTaskInfo[]> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.listBackgroundTasks({ activeOnly: false })
    },
    sessionIdArgsSchema,
  )

  // ── Skills ──────────────────────────────────────────────────────

  secureInvoke('lmcode:listSkills', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listSkills()
  }, sessionIdArgsSchema)

  secureInvoke('lmcode:activateSkill', async (_event, sessionId: string, name: string, args?: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.activateSkill(name, args)
  }, activateSkillArgsSchema)

  // ── MCP servers ─────────────────────────────────────────────────

  secureInvoke('lmcode:listMcpServers', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listMcpServers()
  }, sessionIdArgsSchema)

  secureInvoke('lmcode:reconnectMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.reconnectMcpServer(name)
  }, sessionNamedArgsSchema)

  secureInvoke(
    'lmcode:addMcpServer',
    async (_event, sessionId: string, name: string, config: Record<string, unknown>): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.addMcpServer(name, config)
    },
    addMcpServerArgsSchema,
  )

  secureInvoke('lmcode:stopMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.stopMcpServer(name)
  }, sessionNamedArgsSchema)

  secureInvoke('lmcode:removeMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.removeMcpServer(name)
  }, sessionNamedArgsSchema)

  // ── Computer use ────────────────────────────────────────────────

  secureInvoke('lmcode:getComputerUseDriver', async (): Promise<ComputerUseDriverInfo> => {
    return getComputerUseDriverInfo()
  })

  secureInvoke('lmcode:installComputerUseDriver', async (): Promise<ComputerUseInstallResult> => {
    const result = await installComputerUseDriver()
    auditLog?.info('desktop critical operation completed', {
      operation: 'computer-use.install-driver',
      ok: result.ok,
    })
    return result
  })

  secureInvoke('lmcode:getComputerUseStatus', async (_event, sessionId: string): Promise<ComputerUseStatus> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.getComputerUseStatus()
  }, sessionIdArgsSchema)

  secureInvoke(
    'lmcode:setComputerUseEnabled',
    async (_event, sessionId: string, enabled: boolean): Promise<ComputerUseStatus> => {
      const entry = await ensureActiveSession(sessionId)
      const status = await entry.session.setComputerUseEnabled(enabled)
      auditLog?.info('desktop critical operation completed', {
        operation: 'computer-use.set-enabled',
        enabled,
        phase: status.phase,
      })
      return status
    },
    setComputerUseEnabledArgsSchema,
  )

  // ── Config ──────────────────────────────────────────────────────

  secureInvoke('lmcode:getConfig', async (): Promise<LmcodeConfig> => {
    return sanitizeConfigForRenderer(await harness.getConfig())
  })

  secureInvoke(
    'lmcode:getProviderUsage',
    async (_event, force: unknown): Promise<ProviderUsageSnapshot> => {
      return providerUsage.get(force === true)
    },
    optionalBooleanArgsSchema,
  )

  secureInvoke('lmcode:setConfig', async (_event, patch: LmcodeConfigPatch): Promise<LmcodeConfig> => {
    const current = await harness.getConfig()
    const config = await harness.setConfig(restoreRedactedConfigPatch(patch, current))
    providerUsage.invalidate()
    auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.update',
    })
    return sanitizeConfigForRenderer(config)
  }, setConfigArgsSchema)

  secureInvoke('lmcode:removeProvider', async (_event, providerId: string): Promise<LmcodeConfig> => {
    const config = await harness.removeProvider(providerId)
    providerUsage.invalidate()
    auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.remove',
    })
    return sanitizeConfigForRenderer(config)
  }, idArgsSchema)

  secureInvoke('lmcode:removeModel', async (_event, modelId: string): Promise<LmcodeConfig> => {
    const config = await harness.removeModel(modelId)
    providerUsage.invalidate()
    return sanitizeConfigForRenderer(config)
  }, idArgsSchema)

  // ── File operations ─────────────────────────────────────────────

  secureInvoke('lmcode:readFileContent', async (_event, filePath: string): Promise<TextAttachment> => {
    return readTextAttachment(filePath, credentialRoots)
  }, filePathArgsSchema)

  secureInvoke(
    'lmcode:readFileAttachment',
    async (_event, filePath: string): Promise<FileAttachmentPreview> => {
      return readFileAttachment(filePath, credentialRoots)
    },
    filePathArgsSchema,
  )

  secureInvoke(
    'lmcode:readInlineImageAttachment',
    async (_event, name: string, dataUrl: string): Promise<FileAttachmentPreview> => {
      return readInlineImageAttachment(name, dataUrl)
    },
    inlineImageArgsSchema,
  )

  // ── Git review ─────────────────────────────────────────────────

  secureInvoke(
    'lmcode:getGitSnapshot',
    async (_event, sessionId: string): Promise<GitRepositorySnapshot> => {
      return inspectGitRepository(await getSessionWorkDir(sessionId))
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:getGitFileDiff',
    async (_event, sessionId: string, filePath: string): Promise<GitFileDiff> => {
      return inspectGitFileDiff(await getSessionWorkDir(sessionId), filePath)
    },
    sessionNamedArgsSchema,
  )

  secureInvoke(
    'lmcode:setGitFileStaged',
    async (
      _event,
      sessionId: string,
      filePath: string,
      staged: boolean,
    ): Promise<void> => {
      await setGitFileStaged(await getSessionWorkDir(sessionId), filePath, staged)
    },
    setGitFileStagedArgsSchema,
  )

  secureInvoke(
    'lmcode:setAllGitFilesStaged',
    async (_event, sessionId: string, staged: boolean): Promise<void> => {
      await setAllGitFilesStaged(await getSessionWorkDir(sessionId), staged)
    },
    setAllGitFilesStagedArgsSchema,
  )

  secureInvoke(
    'lmcode:applyGitHunkAction',
    async (_event, sessionId: string, input: GitHunkActionInput): Promise<void> => {
      await applyGitHunkAction(await getSessionWorkDir(sessionId), input)
    },
    applyGitHunkActionArgsSchema,
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
        await getSessionWorkDir(sessionId),
        filePath,
        scope,
        (target) => shell.trashItem(target),
      )
      auditLog?.info('desktop critical operation completed', {
        operation: 'git.discard-file',
      })
    },
    discardGitFileChangesArgsSchema,
  )

  secureInvoke(
    'lmcode:discardAllGitChanges',
    async (_event, sessionId: string): Promise<void> => {
      await discardAllGitChanges(
        await getSessionWorkDir(sessionId),
        (target) => shell.trashItem(target),
      )
      auditLog?.info('desktop critical operation completed', {
        operation: 'git.discard-all',
      })
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:commitGitChanges',
    async (_event, sessionId: string, message: string): Promise<GitCommitResult> => {
      const result = await commitGitChanges(await getSessionWorkDir(sessionId), message)
      auditLog?.info('desktop critical operation completed', {
        operation: 'git.commit',
      })
      return result
    },
    commitGitChangesArgsSchema,
  )

  // ── Git worktrees ───────────────────────────────────────────────

  secureInvoke(
    'lmcode:listGitWorktrees',
    async (_event, sessionId: string): Promise<readonly GitWorktreeInfo[]> => {
      return listGitWorktrees(await getSessionWorkDir(sessionId))
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:createWorktreeHandoff',
    async (
      _event,
      sessionId: string,
      branchName: string,
    ): Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }> => {
      const worktree = await createGitWorktree(
        await getSessionWorkDir(sessionId),
        harness.homeDir,
        branchName,
      )
      return { worktree, session: await forkSessionIntoWorktree(sessionId, worktree) }
    },
    worktreeHandoffArgsSchema,
  )

  secureInvoke(
    'lmcode:handoffToWorktree',
    async (
      _event,
      sessionId: string,
      worktreePath: string,
    ): Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }> => {
      const worktree = await resolveGitWorktree(
        await getSessionWorkDir(sessionId),
        worktreePath,
      )
      return { worktree, session: await forkSessionIntoWorktree(sessionId, worktree) }
    },
    worktreeHandoffArgsSchema,
  )

  // ── Project terminal ────────────────────────────────────────────

  secureInvoke(
    'lmcode:startTerminal',
    async (_event, sessionId: string): Promise<ProjectTerminalInfo> => {
      return terminalManager.start(sessionId, await getSessionWorkDir(sessionId))
    },
    sessionIdArgsSchema,
  )

  secureInvoke(
    'lmcode:writeTerminal',
    (_event, sessionId: string, input: string): void => {
      terminalManager.write(sessionId, input)
    },
    writeTerminalArgsSchema,
  )

  secureInvoke(
    'lmcode:stopTerminal',
    async (_event, sessionId: string): Promise<void> => {
      await terminalManager.stop(sessionId)
    },
    sessionIdArgsSchema,
  )

  // ── Version ─────────────────────────────────────────────────────

  secureInvoke('lmcode:getVersion', (): string => {
    return app.getVersion()
  })

  // ── Misc ────────────────────────────────────────────────────────

  secureInvoke('lmcode:getHomeDir', (): string => {
    return harness.homeDir
  })

  // ── Shell / file open actions ───────────────────────────────────
  // 点击输出文件、右键「资源管理器 / VSCode 打开」都走这里。输入来自模型
  // 可控的工具结果文本，所以只接受绝对本地路径或 https 外链，不经 shell 拼接。

  secureInvoke('lmcode:openPath', async (_event, input: string): Promise<string> => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) {
      return typeof input !== 'string' || input.trim().length === 0 ? '路径为空' : '仅支持打开本地绝对路径'
    }
    if (isUnsafeShellOpenPath(target)) {
      return '不支持直接打开可执行或脚本文件，请用「在资源管理器中显示」'
    }
    const checked = await checkShellOpenTarget(target)
    if (!checked.ok) return checked.reason
    return (await shell.openPath(target)) || ''
  }, openPathArgsSchema)

  secureInvoke('lmcode:openExternal', async (_event, url: string): Promise<void> => {
    if (!isSafeExternalHttpsUrl(url)) return
    await shell.openExternal(url.trim())
  }, openExternalArgsSchema)

  secureInvoke('lmcode:showItemInFolder', async (_event, input: string): Promise<string> => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) return '仅支持打开本地绝对路径'
    shell.showItemInFolder(target)
    return ''
  }, openPathArgsSchema)

  secureInvoke('lmcode:openInVscode', async (_event, input: string): Promise<string> => {
    const target = normalizeOpenPathTarget(input)
    if (target === null) return '仅支持打开本地绝对路径'
    const executable = resolveVscodeExecutable()
    if (executable === null) {
      return '未找到 VSCode（可用环境变量 LMCODE_VSCODE_PATH 指定 Code.exe 路径）'
    }
    const child = spawn(executable, [target], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return ''
  }, openPathArgsSchema)

  secureInvoke('lmcode:getNoProjectWorkDir', (): string => {
    return resolveNoProjectWorkDir()
  })

  // ── Approval / Question responses ──────────────────────────────

  secureInvoke('lmcode:respondApproval', (_event, payload: {
    requestId: string
    response: ApprovalResponse
  }): void => {
    if (!hub.respondApproval(payload.requestId, payload.response)) {
      throw new Error(`Approval request "${payload.requestId}" is no longer pending`)
    }
  }, respondApprovalArgsSchema)

  secureInvoke('lmcode:respondQuestion', (_event, payload: {
    requestId: string
    result: QuestionResult
  }): void => {
    if (!hub.respondQuestion(payload.requestId, payload.result)) {
      throw new Error(`Question request "${payload.requestId}" is no longer pending`)
    }
  }, respondQuestionArgsSchema)

  // ── Remote service (settings panel control) ──────────────────────

  if (remote !== undefined) {
    remote.setHostReleaseSession(async (sessionId) => {
      await teardownSession(sessionId, 'close', async () => {
        // Local desktop resources only; the remote caller owns harness close/delete.
      })
    })

    secureInvoke('lmcode:getRemoteState', async (): Promise<RemoteState> => {
      return remote.getState()
    })

    secureInvoke('lmcode:setRemoteEnabled', async (_event, enabled: boolean): Promise<RemoteState> => {
      return remote.setEnabled(enabled)
    }, setRemoteEnabledArgsSchema)

    secureInvoke('lmcode:setRemotePort', async (_event, port: number): Promise<RemoteState> => {
      return remote.setPort(port)
    }, setRemotePortArgsSchema)

    secureInvoke('lmcode:regenerateRemoteToken', async (): Promise<RemoteState> => {
      return remote.regenerateToken()
    })
  }

  // ── Remote firewall (LAN reachability for phones) ─────────────────

  secureInvoke('lmcode:getRemoteFirewallStatus', async (): Promise<RemoteFirewallStatus> => {
    return getRemoteFirewallStatus(process.execPath)
  })

  secureInvoke('lmcode:repairRemoteFirewall', async (): Promise<RemoteFirewallStatus> => {
    return repairRemoteFirewall(process.execPath)
  })

  // ── App control ─────────────────────────────────────────────────

  secureOn('lmcode:quit', () => {
    app.quit()
  })

  // ── Desktop notifications ──────────────────────────────────────

  // Renderer-originated notifications (currently: a background session's
  // turn finished). The renderer sees everything while the window is
  // focused, so only escalate to the OS when the user is looking
  // elsewhere. Approval notifications keep their own main-side path.
  secureOn('lmcode:sendNotification', (_event, payload: DesktopNotificationPayload) => {
    if (mainWindow.isDestroyed() || mainWindow.isFocused()) return
    if (payload?.kind !== 'turn-completed' || typeof payload.title !== 'string') return
    if (payload.body !== undefined && typeof payload.body !== 'string') return
    const title = payload.title.trim().slice(0, 120) || '新任务'
    const body = (payload.body?.trim() || '后台任务的回合已完成').slice(0, 200)
    sendNotification(`LMCODE - ${title}`, body)
  })

  // ── Memory store ───────────────────────────────────────────────

  // Keep memory in the same profile boundary as this runtime's config. This is
  // intentionally isolated from the CLI and from the other desktop profile.
  // A shared store is injected by the app lifecycle so the remote bridge and
  // the desktop IPC layer operate on the same SQLite store. When no store is
  // injected, this handler owns the instance it creates and closes it here.
  const memoryStoreInstance =
    memoryStore ?? new MemoryMemoStore(dirname(harness.configPath))
  const ownsMemoryStore = memoryStore === undefined

  secureInvoke('lmcode:listMemories', async (): Promise<MemoryMemoSummary[]> => {
    const result = await memoryStoreInstance.list({ limit: 100 })
    return result.memos
  })

  secureInvoke('lmcode:searchMemories', async (_event, query: string): Promise<MemoryMemoSummary[]> => {
    const result = await memoryStoreInstance.list({ search: query, limit: 20 })
    return result.memos
  }, searchMemoriesArgsSchema)

  secureInvoke('lmcode:deleteMemory', async (_event, id: string): Promise<void> => {
    await memoryStoreInstance.delete(id)
    auditLog?.info('desktop critical operation completed', {
      operation: 'memory.delete',
    })
  }, idArgsSchema)

  // ── Background task operations ─────────────────────────────────

  secureInvoke(
    'lmcode:stopTask',
    async (_event, sessionId: string, taskId: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.stopBackgroundTask(taskId, { reason: 'Stopped from LMCODE Desktop' })
    },
    sessionNamedArgsSchema,
  )

  secureInvoke(
    'lmcode:getTaskOutput',
    async (_event, sessionId: string, taskId: string): Promise<string> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getBackgroundTaskOutput(taskId)
    },
    sessionNamedArgsSchema,
  )

  // Cron managers are session-owned. Resume every session that has persisted
  // jobs so its automations continue firing while the desktop app is open,
  // even when that conversation is not the selected tab.
  const scheduledSessionsActivation = resumeScheduledSessions({
    listIds: async () => scheduledSessionIds(await harness.listSessions()),
    resume: async (id) => {
      await ensureActiveSession(id)
    },
    isClosing: () => closing,
    logWarn: (message, error) => {
      auditLog?.warn(message, { errorKind: error instanceof Error ? error.message : typeof error })
    },
  })

  // ── Cleanup on window close ─────────────────────────────────────

  const cancelAllPendingInteractions = (): void => {
    hub.settleAll()
  }

  // A reload or renderer crash destroys the UI that owns the dialogs. Resolve
  // every reverse-RPC request immediately so agent turns cannot hang forever.
  // In-page navigations (pushState/hash) keep the document and its dialogs
  // alive, so pending interactions must survive them.
  // Skip the first document load: scheduled sessions may already have raised
  // an approval before the renderer finishes mounting.
  let rendererDocumentReady = false
  const handleNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace && rendererDocumentReady) cancelAllPendingInteractions()
  }
  const handleRendererFinishedLoad = (): void => {
    if (!rendererDocumentReady) {
      rendererDocumentReady = true
      return
    }
    cancelAllPendingInteractions()
  }
  const handleRenderProcessGone = (): void => {
    cancelAllPendingInteractions()
  }

  const performClose = async (): Promise<void> => {
    const errors: unknown[] = []
    const runStep = (step: () => void): void => {
      try {
        step()
      } catch (error) {
        errors.push(error)
      }
    }

    await scheduledSessionsActivation
    runStep(() => mainWindow.webContents.removeListener('did-start-navigation', handleNavigation))
    runStep(() => mainWindow.webContents.removeListener('did-finish-load', handleRendererFinishedLoad))
    runStep(() => mainWindow.webContents.removeListener('render-process-gone', handleRenderProcessGone))
    runStep(() => mainWindow.removeListener('closed', handleWindowClosed))

    for (const channel of invokeChannels) runStep(() => ipcMain.removeHandler(channel))
    for (const { channel, listener } of eventListeners) {
      runStep(() => ipcMain.removeListener(channel, listener))
    }

    runStep(cancelAllPendingInteractions)
    runStep(() => hub.detachSurface('renderer'))
    for (const entry of activeSessions.values()) {
      runStep(entry.unsubscribeEvent)
    }
    activeSessions.clear()
    try {
      await terminalManager.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      if (ownsMemoryStore) await memoryStoreInstance.close()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close desktop IPC resources')
    }
  }

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    // Flip the gate synchronously so a resume that resolves after this call
    // cannot attach listeners back to the retired renderer.
    closing = true
    closePromise = performClose()
    return closePromise
  }

  const handleWindowClosed = (): void => {
    void close().catch(() => {
      // The app-level lifecycle awaits the same single-flight cleanup and reports it.
    })
  }

  mainWindow.webContents.on('did-start-navigation', handleNavigation)
  mainWindow.webContents.on('did-finish-load', handleRendererFinishedLoad)
  mainWindow.webContents.on('render-process-gone', handleRenderProcessGone)
  mainWindow.on('closed', handleWindowClosed)

  return {
    close,
    invalidateProviderUsage: () => {
      providerUsage.invalidate()
    },
  }
}

/** 定位 VSCode 主程序。Windows 上 code 命令是 .cmd，无法安全地 shell-less spawn，直接找 Code.exe。 */
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
    // scoop / 自定义安装位置兜底
    candidates.push(join(process.env['USERPROFILE'], 'scoop', 'apps', 'vscode', 'current', 'Code.exe'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
