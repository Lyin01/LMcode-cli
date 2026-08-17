import { ipcMain, BrowserWindow, Notification } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { MemoryMemoStore } from '@lmcode/memory'
import type {
  Session,
  Event,
  LmcodeHarness,
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  SessionSummary,
  Logger,
} from '@lmcode-cli/lmcode-sdk'
import { dirname, join } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/worktree-types.js'
import type { TerminalOutputPayload } from '../../shared/terminal-types.js'
import { ProjectTerminalManager } from '../project-terminal.js'
import { isTrustedIpcSender } from '../security.js'
import {
  CANCELLED_APPROVAL,
  InteractionHub,
  type InteractionSurface,
} from '../remote/interaction-hub.js'
import { ProviderUsageService } from '../provider-usage.js'
import { scheduledSessionIds } from '../scheduled-sessions.js'
import type { DesktopHandlerContext, RemoteController, SessionEntry } from './handler-context.js'
import { registerAutomationHandlers } from './handlers/automations.js'
import { registerChatHandlers } from './handlers/chat.js'
import { registerConfigHandlers } from './handlers/config.js'
import { registerExtensionHandlers } from './handlers/extensions.js'
import { registerFilesGitHandlers } from './handlers/files-git.js'
import { registerSessionHandlers } from './handlers/sessions.js'
import { registerSystemHandlers } from './handlers/system.js'

export type { RemoteController } from './handler-context.js'

export interface DesktopHandlerRegistration {
  close(): Promise<void>
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
 *
 * The shared infrastructure below (sender validation, closing gate, session
 * resume dedup, interaction hub, audit log) is assembled once; each functional
 * domain registers its channels in a dedicated `handlers/*` module through the
 * {@link DesktopHandlerContext}.
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

  // Keep memory in the same profile boundary as this runtime's config. This is
  // intentionally isolated from the CLI and from the other desktop profile.
  // A shared store is injected by the app lifecycle so the remote bridge and
  // the desktop IPC layer operate on the same SQLite store. When no store is
  // injected, this handler owns the instance it creates and closes it here.
  const memoryStoreInstance =
    memoryStore ?? new MemoryMemoStore(dirname(harness.configPath))
  const ownsMemoryStore = memoryStore === undefined

  const ctx: DesktopHandlerContext = {
    harness,
    mainWindow,
    auditLog,
    secureInvoke,
    secureOn,
    ensureActiveSession,
    getSessionWorkDir,
    setupSessionListeners,
    activeSessions,
    resumingSessions,
    credentialRoots,
    interactionHub: hub,
    terminalManager,
    providerUsage,
    memoryStore: memoryStoreInstance,
    resolveNoProjectWorkDir,
    forkSessionIntoWorktree,
    remoteController: remote,
    sendNotification,
  }

  // Functional domains register their own channels through the shared context.
  registerSessionHandlers(ctx)
  registerChatHandlers(ctx)
  registerAutomationHandlers(ctx)
  registerExtensionHandlers(ctx)
  registerConfigHandlers(ctx)
  registerFilesGitHandlers(ctx)
  registerSystemHandlers(ctx)

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
