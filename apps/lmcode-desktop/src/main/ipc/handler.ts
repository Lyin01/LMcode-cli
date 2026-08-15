import { app, ipcMain, BrowserWindow, dialog, Notification, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { MemoryMemoStore } from '@lmcode/memory'
import type { MemoryMemoSummary } from '@lmcode/memory'
import type {
  Session,
  Event,
  LmcodeHarness,
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  SessionSummary,
  ResumedSessionState,
  LmcodeConfig,
  LmcodeConfigPatch,
  GoalSnapshotData,
  CronJobInfo,
  BackgroundTaskInfo,
  SessionStatus,
  Logger,
} from '@lmcode-cli/lmcode-sdk'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RemoteState } from '../../shared/remote-types.js'
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
import {
  CANCELLED_APPROVAL,
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
import { scheduledSessionIds } from '../scheduled-sessions.js'
import {
  restoreRedactedConfigPatch,
  sanitizeConfigForRenderer,
} from '../config-security.js'
import { ProviderUsageService } from '../provider-usage.js'
import { isPermissionMode } from '../../shared/permission-mode.js'
import type { ProviderUsageSnapshot } from '../../shared/provider-usage-types.js'

interface SessionEntry {
  session: Session
  unsubscribeEvent: () => void
}

export interface DesktopHandlerRegistration {
  close(): Promise<void>
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
}

/**
 * Send a desktop notification (approval request, task completed, etc.)
 */
function sendNotification(title: string, body: string): void {
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
      if (mainWindow.isDestroyed()) return false
      try {
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

    session.setApprovalHandler((request: ApprovalRequest): Promise<ApprovalResponse> => {
      if (closing) return Promise.resolve(CANCELLED_APPROVAL)

      sendNotification(
        'LMCODE - 审批请求',
        `需要审批：${request.action || '执行操作'}`,
      )

      return hub.requestApproval(session.id, request)
    })

    session.setQuestionHandler((request: QuestionRequest): Promise<QuestionResult> => {
      if (closing) return Promise.resolve(null)
      return hub.requestQuestion(session.id, request)
    })

    activeSessions.set(session.id, { session, unsubscribeEvent })
  }

  function secureInvoke<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
  ): void {
    ipcMain.handle(channel, async (event, ...args) => {
      if (closing) throw new Error(`Desktop IPC registration is closed on "${channel}"`)
      if (!isTrustedIpcSender(event, mainWindow.webContents, trustedRendererUrl)) {
        throw new Error(`Rejected IPC from an untrusted renderer on "${channel}"`)
      }
      try {
        return await listener(event, ...(args as Args))
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
      listener(event, ...(args as Args))
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
  async function ensureActiveSession(sessionId: string): Promise<SessionEntry> {
    if (closing) throw new Error('Desktop IPC registration is closed')
    const existing = activeSessions.get(sessionId)
    if (existing) return existing

    const inflight = resumingSessions.get(sessionId)
    if (inflight) return inflight

    const pending = (async (): Promise<SessionEntry> => {
      const session = await harness.resumeSession({ id: sessionId })
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
  })

  secureInvoke(
    'lmcode:selectWorkDirectory',
    async (_event, initialDirectory?: string): Promise<string | undefined> => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 LMCODE 项目文件夹',
        defaultPath: initialDirectory?.trim() || app.getPath('home'),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled) return undefined
      return result.filePaths[0]
    },
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
  })

  secureInvoke('lmcode:deleteSession', async (_event, id: string): Promise<void> => {
    await terminalManager.stop(id)
    // A resume still in flight for this session would re-attach it to
    // activeSessions after the delete (the SDK reads the store once at the
    // start of resumeSession, so it cannot observe a mid-flight deletion).
    // Let it settle first so the delete below unregisters the session.
    const inflightResume = resumingSessions.get(id)
    if (inflightResume) await inflightResume.catch(() => {})
    const entry = activeSessions.get(id)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(id)
    }
    hub.settleSession(id)
    try {
      await harness.deleteSession(id)
      auditLog?.info('desktop critical operation completed', {
        operation: 'session.delete',
      })
    } finally {
      hub.settleSession(id)
    }
  })

  secureInvoke('lmcode:exportSession', async (_event, id: string): Promise<string> => {
    const result = await harness.exportSession({ id, version: app.getVersion() })
    return result.zipPath
  })

  secureInvoke(
    'lmcode:saveTextFile',
    async (
      _event,
      input: { readonly suggestedName: string; readonly content: string },
    ): Promise<string | null> => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出为文件',
        defaultPath: input.suggestedName.trim() || 'export.txt',
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, input.content, 'utf8')
      return result.filePath
    },
  )

  secureInvoke('lmcode:listSessions', async (): Promise<readonly SessionSummary[]> => {
    return harness.listSessions()
  })

  secureInvoke('lmcode:renameSession', async (_event, id: string, title: string): Promise<void> => {
    await harness.renameSession({ id, title })
  })

  // ── Chat ────────────────────────────────────────────────────────

  secureInvoke(
    'lmcode:sendMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.prompt(await buildDesktopPromptInput(request, credentialRoots))
    },
  )

  secureInvoke(
    'lmcode:steerMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.steer(await buildDesktopPromptInput(request, credentialRoots))
    },
  )

  secureInvoke('lmcode:cancelResponse', async (_event, sessionId: string): Promise<void> => {
    hub.settleSession(sessionId)
    const entry = activeSessions.get(sessionId)
    if (!entry) throw new Error(`Session "${sessionId}" not found`)
    try {
      await entry.session.cancel()
    } finally {
      // Cancellation can itself race a new reverse-RPC request. Sweep again
      // after the SDK has finished unwinding the active turn.
      hub.settleSession(sessionId)
    }
  })

  // Return the persisted conversation history so the UI can re-render a session's
  // messages after a restart or when switching back to it.
  secureInvoke('lmcode:getSessionHistory', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    const ctx = await entry.session.getContext()
    return ctx.history
  })

  secureInvoke(
    'lmcode:getSessionStatus',
    async (_event, sessionId: string): Promise<SessionStatus> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getStatus()
    },
  )

  // ── Session control ─────────────────────────────────────────────

  secureInvoke('lmcode:setModel', async (_event, sessionId: string, model: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setModel(model)
  })

  secureInvoke('lmcode:setThinking', async (_event, sessionId: string, level: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setThinking(level)
  })

  secureInvoke('lmcode:setPermission', async (_event, sessionId: string, mode: unknown): Promise<void> => {
    if (!isPermissionMode(mode)) throw new Error('Invalid permission mode')
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setPermission(mode)
  })

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
  )

  secureInvoke(
    'lmcode:getGoal',
    async (_event, sessionId: string): Promise<{ readonly goal: GoalSnapshotData | null }> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getGoal()
    },
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
  )

  secureInvoke(
    'lmcode:cancelGoal',
    async (_event, sessionId: string): Promise<GoalSnapshotData | null> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.cancelGoal()
    },
  )

  secureInvoke(
    'lmcode:setPlanMode',
    async (_event, sessionId: string, enabled: boolean): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.setPlanMode(enabled)
    },
  )

  secureInvoke(
    'lmcode:compactSession',
    async (_event, sessionId: string, instruction?: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.compact({ instruction })
    },
  )

  secureInvoke(
    'lmcode:undoHistory',
    async (_event, sessionId: string, count: number): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.undoHistory(count)
    },
  )

  secureInvoke('lmcode:closeSession', async (_event, sessionId: string): Promise<void> => {
    await terminalManager.stop(sessionId)
    const entry = activeSessions.get(sessionId)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(sessionId)
    }
    hub.settleSession(sessionId)
    try {
      await harness.closeSession(sessionId)
    } finally {
      hub.settleSession(sessionId)
    }
  })

  // ── Scheduled automations ──────────────────────────────────────

  secureInvoke(
    'lmcode:listCronJobs',
    async (_event, sessionId: string): Promise<readonly CronJobInfo[]> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.listCronJobs()
    },
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
  )

  secureInvoke(
    'lmcode:deleteCronJob',
    async (_event, sessionId: string, id: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.deleteCronJob(id)
    },
  )

  secureInvoke(
    'lmcode:listBackgroundTasks',
    async (_event, sessionId: string): Promise<readonly BackgroundTaskInfo[]> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.listBackgroundTasks({ activeOnly: false })
    },
  )

  // ── Skills ──────────────────────────────────────────────────────

  secureInvoke('lmcode:listSkills', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listSkills()
  })

  secureInvoke('lmcode:activateSkill', async (_event, sessionId: string, name: string, args?: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.activateSkill(name, args)
  })

  // ── MCP servers ─────────────────────────────────────────────────

  secureInvoke('lmcode:listMcpServers', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listMcpServers()
  })

  secureInvoke('lmcode:reconnectMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.reconnectMcpServer(name)
  })

  secureInvoke('lmcode:addMcpServer', async (_event, sessionId: string, name: string, config: Record<string, unknown>): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.addMcpServer(name, config)
  })

  secureInvoke('lmcode:stopMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.stopMcpServer(name)
  })

  secureInvoke('lmcode:removeMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.removeMcpServer(name)
  })

  // ── Config ──────────────────────────────────────────────────────

  secureInvoke('lmcode:getConfig', async (): Promise<LmcodeConfig> => {
    return sanitizeConfigForRenderer(await harness.getConfig())
  })

  secureInvoke(
    'lmcode:getProviderUsage',
    async (_event, force: unknown): Promise<ProviderUsageSnapshot> => {
      return providerUsage.get(force === true)
    },
  )

  secureInvoke('lmcode:setConfig', async (_event, patch: LmcodeConfigPatch): Promise<LmcodeConfig> => {
    const current = await harness.getConfig()
    const config = await harness.setConfig(restoreRedactedConfigPatch(patch, current))
    providerUsage.invalidate()
    auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.update',
    })
    return sanitizeConfigForRenderer(config)
  })

  secureInvoke('lmcode:removeProvider', async (_event, providerId: string): Promise<LmcodeConfig> => {
    const config = await harness.removeProvider(providerId)
    providerUsage.invalidate()
    auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.remove',
    })
    return sanitizeConfigForRenderer(config)
  })

  secureInvoke('lmcode:removeModel', async (_event, modelId: string): Promise<LmcodeConfig> => {
    return sanitizeConfigForRenderer(await harness.removeModel(modelId))
  })

  // ── File operations ─────────────────────────────────────────────

  secureInvoke('lmcode:readFileContent', async (_event, filePath: string): Promise<TextAttachment> => {
    return readTextAttachment(filePath, credentialRoots)
  })

  secureInvoke(
    'lmcode:readFileAttachment',
    async (_event, filePath: string): Promise<FileAttachmentPreview> => {
      return readFileAttachment(filePath, credentialRoots)
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
      return inspectGitRepository(await getSessionWorkDir(sessionId))
    },
  )

  secureInvoke(
    'lmcode:getGitFileDiff',
    async (_event, sessionId: string, filePath: string): Promise<GitFileDiff> => {
      return inspectGitFileDiff(await getSessionWorkDir(sessionId), filePath)
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
      await setGitFileStaged(await getSessionWorkDir(sessionId), filePath, staged)
    },
  )

  secureInvoke(
    'lmcode:setAllGitFilesStaged',
    async (_event, sessionId: string, staged: boolean): Promise<void> => {
      await setAllGitFilesStaged(await getSessionWorkDir(sessionId), staged)
    },
  )

  secureInvoke(
    'lmcode:applyGitHunkAction',
    async (_event, sessionId: string, input: GitHunkActionInput): Promise<void> => {
      await applyGitHunkAction(await getSessionWorkDir(sessionId), input)
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
        await getSessionWorkDir(sessionId),
        filePath,
        scope,
        (target) => shell.trashItem(target),
      )
      auditLog?.info('desktop critical operation completed', {
        operation: 'git.discard-file',
      })
    },
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
  )

  // ── Git worktrees ───────────────────────────────────────────────

  secureInvoke(
    'lmcode:listGitWorktrees',
    async (_event, sessionId: string): Promise<readonly GitWorktreeInfo[]> => {
      return listGitWorktrees(await getSessionWorkDir(sessionId))
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
        await getSessionWorkDir(sessionId),
        harness.homeDir,
        branchName,
      )
      return { worktree, session: await forkSessionIntoWorktree(sessionId, worktree) }
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
        await getSessionWorkDir(sessionId),
        worktreePath,
      )
      return { worktree, session: await forkSessionIntoWorktree(sessionId, worktree) }
    },
  )

  // ── Project terminal ────────────────────────────────────────────

  secureInvoke(
    'lmcode:startTerminal',
    async (_event, sessionId: string): Promise<ProjectTerminalInfo> => {
      return terminalManager.start(sessionId, await getSessionWorkDir(sessionId))
    },
  )

  secureInvoke(
    'lmcode:writeTerminal',
    (_event, sessionId: string, input: string): void => {
      terminalManager.write(sessionId, input)
    },
  )

  secureInvoke(
    'lmcode:stopTerminal',
    async (_event, sessionId: string): Promise<void> => {
      await terminalManager.stop(sessionId)
    },
  )

  // ── Version ─────────────────────────────────────────────────────

  secureInvoke('lmcode:getVersion', (): string => {
    return app.getVersion()
  })

  // ── Misc ────────────────────────────────────────────────────────

  secureInvoke('lmcode:getHomeDir', (): string => {
    return harness.homeDir
  })

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
  })

  secureInvoke('lmcode:respondQuestion', (_event, payload: {
    requestId: string
    result: QuestionResult
  }): void => {
    if (!hub.respondQuestion(payload.requestId, payload.result)) {
      throw new Error(`Question request "${payload.requestId}" is no longer pending`)
    }
  })

  // ── Remote service (settings panel control) ──────────────────────

  if (remote !== undefined) {
    secureInvoke('lmcode:getRemoteState', async (): Promise<RemoteState> => {
      return remote.getState()
    })

    secureInvoke('lmcode:setRemoteEnabled', async (_event, enabled: unknown): Promise<RemoteState> => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid remote enabled value')
      return remote.setEnabled(enabled)
    })

    secureInvoke('lmcode:setRemotePort', async (_event, port: unknown): Promise<RemoteState> => {
      if (typeof port !== 'number' || !Number.isFinite(port)) {
        throw new Error('Invalid remote port')
      }
      return remote.setPort(port)
    })

    secureInvoke('lmcode:regenerateRemoteToken', async (): Promise<RemoteState> => {
      return remote.regenerateToken()
    })
  }

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
    const title = payload.title.trim().slice(0, 120) || '新任务'
    const body = (payload.body ?? '后台任务的回合已完成').slice(0, 200)
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
  })

  secureInvoke('lmcode:deleteMemory', async (_event, id: string): Promise<void> => {
    await memoryStoreInstance.delete(id)
    auditLog?.info('desktop critical operation completed', {
      operation: 'memory.delete',
    })
  })

  // ── Background task operations ─────────────────────────────────

  secureInvoke(
    'lmcode:stopTask',
    async (_event, sessionId: string, taskId: string): Promise<void> => {
      const entry = await ensureActiveSession(sessionId)
      await entry.session.stopBackgroundTask(taskId, { reason: 'Stopped from LMCODE Desktop' })
    },
  )

  secureInvoke(
    'lmcode:getTaskOutput',
    async (_event, sessionId: string, taskId: string): Promise<string> => {
      const entry = await ensureActiveSession(sessionId)
      return entry.session.getBackgroundTaskOutput(taskId)
    },
  )

  // Cron managers are session-owned. Resume every session that has persisted
  // jobs so its automations continue firing while the desktop app is open,
  // even when that conversation is not the selected tab.
  const scheduledSessionsActivation = (async (): Promise<void> => {
    const ids = await scheduledSessionIds(await harness.listSessions())
    for (const id of ids) {
      if (closing) return
      try {
        await ensureActiveSession(id)
      } catch {
        // One damaged session must not prevent other automations from loading.
      }
    }
  })().catch(() => {
    // Session discovery is best-effort during startup; opening the panel retries.
  })

  // ── Cleanup on window close ─────────────────────────────────────

  const cancelAllPendingInteractions = (): void => {
    hub.settleAll()
  }

  // A reload or renderer crash destroys the UI that owns the dialogs. Resolve
  // every reverse-RPC request immediately so agent turns cannot hang forever.
  // In-page navigations (pushState/hash) keep the document and its dialogs
  // alive, so pending interactions must survive them.
  const handleNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) cancelAllPendingInteractions()
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
    runStep(() => mainWindow.webContents.removeListener('did-finish-load', cancelAllPendingInteractions))
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
      runStep(() => entry.session.setApprovalHandler(undefined))
      runStep(() => entry.session.setQuestionHandler(undefined))
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
  mainWindow.webContents.on('did-finish-load', cancelAllPendingInteractions)
  mainWindow.webContents.on('render-process-gone', handleRenderProcessGone)
  mainWindow.on('closed', handleWindowClosed)

  return { close }
}
