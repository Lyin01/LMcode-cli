import { app, ipcMain, BrowserWindow, Notification } from 'electron'
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
} from '@lmcode-cli/lmcode-sdk'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import fs from 'node:fs'
import type {
  ApprovalRequestPayload,
  InteractionSettledPayload,
  QuestionRequestPayload,
} from '../../shared/ipc-types.js'
import { PendingInteractionRegistry } from './pending-interactions.js'
import { isTrustedIpcSender } from '../security.js'

interface SessionEntry {
  session: Session
  unsubscribeEvent: () => void
}

interface BackgroundTaskSession extends Session {
  stopBackground?: (input: { taskId: string }) => Promise<void> | void
  getBackgroundOutput?: (input: { taskId: string }) => Promise<string> | string
}

const CANCELLED_APPROVAL: ApprovalResponse = { decision: 'cancelled' }
const REVERSE_RPC_TIMEOUT_MS = 300_000

export interface DesktopHandlerRegistration {
  close(): Promise<void>
}

function notifyInteractionSettled(
  mainWindow: BrowserWindow,
  requestId: string,
  sessionId: string,
): void {
  if (mainWindow.isDestroyed()) return
  const payload: InteractionSettledPayload = { requestId, sessionId }
  try {
    mainWindow.webContents.send('lmcode:interactionSettled', payload)
  } catch {
    // Renderer teardown can race the destroyed check.
  }
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
): DesktopHandlerRegistration {
  const invokeChannels: string[] = []
  const eventListeners: Array<{
    readonly channel: string
    readonly listener: (event: IpcMainEvent, ...args: unknown[]) => void
  }> = []
  const activeSessions = new Map<string, SessionEntry>()
  const pendingApprovals = new PendingInteractionRegistry<ApprovalResponse>()
  const pendingQuestions = new PendingInteractionRegistry<QuestionResult>()
  let closing = false
  let closePromise: Promise<void> | undefined

  function settleSessionInteractions(sessionId: string): void {
    pendingApprovals.settleSession(sessionId, CANCELLED_APPROVAL)
    pendingQuestions.settleSession(sessionId, null)
  }

  /** Set up event forwarding and reverse-RPC handlers for one live session. */
  function setupSessionListeners(session: Session): void {
    if (closing) throw new Error('Desktop IPC registration is closed')

    // Idempotent: replace any listener previously registered by this window.
    const prior = activeSessions.get(session.id)
    if (prior) {
      prior.unsubscribeEvent()
      activeSessions.delete(session.id)
      settleSessionInteractions(session.id)
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

      const requestId = `approval:${session.id}:${randomUUID()}`
      const promise = pendingApprovals.request(requestId, session.id, {
        timeoutMs: REVERSE_RPC_TIMEOUT_MS,
        timeoutValue: CANCELLED_APPROVAL,
        onSettled: (settledRequestId, sessionId) => {
          notifyInteractionSettled(mainWindow, settledRequestId, sessionId)
        },
      })

      if (!mainWindow.isDestroyed()) {
        const payload: ApprovalRequestPayload = {
          sessionId: session.id,
          requestId,
          request,
        }
        try {
          mainWindow.webContents.send('lmcode:approvalRequest', payload)
        } catch {
          pendingApprovals.settle(requestId, CANCELLED_APPROVAL)
        }
      } else {
        pendingApprovals.settle(requestId, CANCELLED_APPROVAL)
      }
      return promise
    })

    session.setQuestionHandler((request: QuestionRequest): Promise<QuestionResult> => {
      if (closing) return Promise.resolve(null)

      const requestId = `question:${session.id}:${randomUUID()}`
      const promise = pendingQuestions.request(requestId, session.id, {
        timeoutMs: REVERSE_RPC_TIMEOUT_MS,
        timeoutValue: null,
        onSettled: (settledRequestId, sessionId) => {
          notifyInteractionSettled(mainWindow, settledRequestId, sessionId)
        },
      })

      if (!mainWindow.isDestroyed()) {
        const payload: QuestionRequestPayload = {
          sessionId: session.id,
          requestId,
          request,
        }
        try {
          mainWindow.webContents.send('lmcode:questionRequest', payload)
        } catch {
          pendingQuestions.settle(requestId, null)
        }
      } else {
        pendingQuestions.settle(requestId, null)
      }
      return promise
    })

    activeSessions.set(session.id, { session, unsubscribeEvent })
  }

  function secureInvoke<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (closing) throw new Error(`Desktop IPC registration is closed on "${channel}"`)
      if (!isTrustedIpcSender(event, mainWindow.webContents, trustedRendererUrl)) {
        throw new Error(`Rejected IPC from an untrusted renderer on "${channel}"`)
      }
      return listener(event, ...(args as Args))
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

  // ── Session management ──────────────────────────────────────────

  secureInvoke('lmcode:createSession', async (_event, opts: {
    workDir: string
    model?: string
    thinking?: string
    permission?: 'yolo' | 'manual' | 'auto'
  }): Promise<SessionSummary | undefined> => {
    // The SDK requires a real working directory. The desktop UI does not yet
    // expose a project picker, so fall back to the user's home directory.
    const workDir = opts.workDir?.trim() ? opts.workDir : app.getPath('home')
    const session = await harness.createSession({ ...opts, workDir })
    setupSessionListeners(session)
    return session.summary
  })

  secureInvoke('lmcode:resumeSession', async (_event, id: string): Promise<{
    summary: SessionSummary
    resumeState: ResumedSessionState | undefined
  }> => {
    const session = await harness.resumeSession({ id })
    setupSessionListeners(session)
    return {
      summary: session.summary!,
      resumeState: session.getResumeState(),
    }
  })

  secureInvoke('lmcode:deleteSession', async (_event, id: string): Promise<void> => {
    const entry = activeSessions.get(id)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(id)
    }
    settleSessionInteractions(id)
    try {
      await harness.deleteSession(id)
    } finally {
      settleSessionInteractions(id)
    }
  })

  secureInvoke('lmcode:exportSession', async (_event, id: string): Promise<string> => {
    const result = await harness.exportSession({ id, version: app.getVersion() })
    return result.zipPath
  })

  secureInvoke('lmcode:listSessions', async (): Promise<readonly SessionSummary[]> => {
    return harness.listSessions()
  })

  secureInvoke('lmcode:renameSession', async (_event, id: string, title: string): Promise<void> => {
    await harness.renameSession({ id, title })
  })

  // ── Chat ────────────────────────────────────────────────────────

  secureInvoke('lmcode:sendMessage', async (_event, sessionId: string, text: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.prompt(text)
  })

  secureInvoke('lmcode:cancelResponse', async (_event, sessionId: string): Promise<void> => {
    settleSessionInteractions(sessionId)
    const entry = activeSessions.get(sessionId)
    if (!entry) throw new Error(`Session "${sessionId}" not found`)
    try {
      await entry.session.cancel()
    } finally {
      // Cancellation can itself race a new reverse-RPC request. Sweep again
      // after the SDK has finished unwinding the active turn.
      settleSessionInteractions(sessionId)
    }
  })

  // Return the persisted conversation history so the UI can re-render a session's
  // messages after a restart or when switching back to it.
  secureInvoke('lmcode:getSessionHistory', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    const ctx = await entry.session.getContext()
    return ctx.history
  })

  // ── Session control ─────────────────────────────────────────────

  secureInvoke('lmcode:setModel', async (_event, sessionId: string, model: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setModel(model)
  })

  secureInvoke('lmcode:setThinking', async (_event, sessionId: string, level: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setThinking(level)
  })

  secureInvoke('lmcode:setPermission', async (_event, sessionId: string, mode: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setPermission(mode as 'yolo' | 'manual' | 'auto')
  })

  secureInvoke('lmcode:closeSession', async (_event, sessionId: string): Promise<void> => {
    const entry = activeSessions.get(sessionId)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(sessionId)
    }
    settleSessionInteractions(sessionId)
    try {
      await harness.closeSession(sessionId)
    } finally {
      settleSessionInteractions(sessionId)
    }
  })

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
    return harness.getConfig()
  })

  secureInvoke('lmcode:setConfig', async (_event, patch: LmcodeConfigPatch): Promise<LmcodeConfig> => {
    return harness.setConfig(patch)
  })

  // ── File operations ─────────────────────────────────────────────

  secureInvoke('lmcode:readFileContent', async (_event, filePath: string): Promise<string> => {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return content
  })

  // ── Version ─────────────────────────────────────────────────────

  secureInvoke('lmcode:getVersion', (): string => {
    return '0.1.0'
  })

  // ── Misc ────────────────────────────────────────────────────────

  secureInvoke('lmcode:getHomeDir', (): string => {
    return harness.homeDir
  })

  // ── Approval / Question responses ──────────────────────────────

  secureInvoke('lmcode:respondApproval', (_event, payload: {
    requestId: string
    response: ApprovalResponse
  }): void => {
    if (!pendingApprovals.settle(payload.requestId, payload.response)) {
      throw new Error(`Approval request "${payload.requestId}" is no longer pending`)
    }
  })

  secureInvoke('lmcode:respondQuestion', (_event, payload: {
    requestId: string
    result: QuestionResult
  }): void => {
    if (!pendingQuestions.settle(payload.requestId, payload.result)) {
      throw new Error(`Question request "${payload.requestId}" is no longer pending`)
    }
  })

  // ── App control ─────────────────────────────────────────────────

  secureOn('lmcode:quit', () => {
    app.quit()
  })

  // ── Memory store ───────────────────────────────────────────────

  // Share the user's existing memory store (~/.lmcode/memory), same dir as the
  // shared config, so the desktop sees the memories the CLI recorded.
  const memoryStore = new MemoryMemoStore(dirname(harness.configPath))

  secureInvoke('lmcode:listMemories', async (): Promise<MemoryMemoSummary[]> => {
    const result = await memoryStore.list({ limit: 100 })
    return result.memos
  })

  secureInvoke('lmcode:searchMemories', async (_event, query: string): Promise<MemoryMemoSummary[]> => {
    const result = await memoryStore.list({ search: query, limit: 20 })
    return result.memos
  })

  secureInvoke('lmcode:deleteMemory', async (_event, id: string): Promise<void> => {
    await memoryStore.delete(id)
  })

  // ── Background task operations ─────────────────────────────────

  secureInvoke('lmcode:stopTask', async (_event, taskId: string): Promise<void> => {
    for (const [_sid, entry] of activeSessions) {
      try {
        await (entry.session as BackgroundTaskSession).stopBackground?.({ taskId })
        return
      } catch {
        // Session doesn't support this method
      }
    }
    throw new Error(`Task "${taskId}" not found or cannot be stopped`)
  })

  secureInvoke('lmcode:getTaskOutput', async (_event, taskId: string): Promise<string> => {
    for (const [_sid, entry] of activeSessions) {
      try {
        const output = await (entry.session as BackgroundTaskSession).getBackgroundOutput?.({ taskId })
        if (output !== undefined) return output
      } catch {
        // Session doesn't support this method
      }
    }
    return ''
  })

  // ── Cleanup on window close ─────────────────────────────────────

  const cancelAllPendingInteractions = (): void => {
    pendingApprovals.settleAll(CANCELLED_APPROVAL)
    pendingQuestions.settleAll(null)
  }

  // A reload or renderer crash destroys the UI that owns the dialogs. Resolve
  // every reverse-RPC request immediately so agent turns cannot hang forever.
  const handleNavigation = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) cancelAllPendingInteractions()
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

    runStep(() => mainWindow.webContents.removeListener('did-start-navigation', handleNavigation))
    runStep(() => mainWindow.webContents.removeListener('did-finish-load', cancelAllPendingInteractions))
    runStep(() => mainWindow.webContents.removeListener('render-process-gone', handleRenderProcessGone))
    runStep(() => mainWindow.removeListener('closed', handleWindowClosed))

    for (const channel of invokeChannels) runStep(() => ipcMain.removeHandler(channel))
    for (const { channel, listener } of eventListeners) {
      runStep(() => ipcMain.removeListener(channel, listener))
    }

    runStep(cancelAllPendingInteractions)
    for (const entry of activeSessions.values()) {
      runStep(entry.unsubscribeEvent)
      runStep(() => entry.session.setApprovalHandler(undefined))
      runStep(() => entry.session.setQuestionHandler(undefined))
    }
    activeSessions.clear()
    try {
      await memoryStore.close()
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
