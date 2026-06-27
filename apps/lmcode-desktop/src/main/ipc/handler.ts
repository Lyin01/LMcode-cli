import { app, ipcMain, BrowserWindow, Notification } from 'electron'
import { LmcodeHarness } from '@lmcode-cli/lmcode-sdk'
import { MemoryMemoStore } from '@lmcode/memory'
import type {
  Session,
  Event,
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  SessionSummary,
  ResumedSessionState,
} from '@lmcode-cli/lmcode-sdk'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import fs from 'node:fs'

interface SessionEntry {
  session: Session
  unsubscribeEvent: () => void
}

const activeSessions = new Map<string, SessionEntry>()

// Pending approval/question resolvers
const pendingApprovals = new Map<
  string,
  { resolve: (value: ApprovalResponse) => void; reject: (err: Error) => void }
>()
const pendingQuestions = new Map<
  string,
  { resolve: (value: QuestionResult) => void; reject: (err: Error) => void }
>()

/**
 * Send a desktop notification (approval request, task completed, etc.)
 */
function sendNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        wins[0].show()
        wins[0].focus()
      }
    })
    notification.show()
  }
}

/**
 * Set up event forwarding and approval/question handlers for a session.
 */
function setupSessionListeners(session: Session, mainWindow: BrowserWindow): void {
  // Idempotent: if this session somehow already has listeners, tear the old ones
  // down first so we never double-forward events (which duplicates every token
  // in the streamed reply).
  const prior = activeSessions.get(session.id)
  if (prior) {
    prior.unsubscribeEvent()
    activeSessions.delete(session.id)
  }

  // Forward all session events to the renderer
  const unsubscribeEvent = session.onEvent((event: Event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lmcode:sessionEvent', {
        sessionId: session.id,
        event,
      })
    }
  })

  // Approval handler — forwards to renderer and waits for response
  session.setApprovalHandler((request: ApprovalRequest): Promise<ApprovalResponse> => {
    // Also send a desktop notification for approval requests
    sendNotification(
      'LMCODE - 审批请求',
      `需要审批：${request.action || '执行操作'}`,
    )

    return new Promise<ApprovalResponse>((resolve, reject) => {
      const requestId = `approval:${session.id}:${randomUUID()}`
      pendingApprovals.set(requestId, { resolve, reject })

      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lmcode:approvalRequest', {
          sessionId: session.id,
          requestId,
          request,
        })
      } else {
        reject(new Error('Window destroyed'))
        pendingApprovals.delete(requestId)
      }
    })
  })

  // Question handler — forwards to renderer and waits for response
  session.setQuestionHandler((request: QuestionRequest): Promise<QuestionResult> => {
    return new Promise<QuestionResult>((resolve, reject) => {
      const requestId = `question:${session.id}:${randomUUID()}`
      pendingQuestions.set(requestId, { resolve, reject })

      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lmcode:questionRequest', {
          sessionId: session.id,
          requestId,
          request,
        })
      } else {
        reject(new Error('Window destroyed'))
        pendingQuestions.delete(requestId)
      }
    })
  })

  activeSessions.set(session.id, { session, unsubscribeEvent })
}

/**
 * Register all IPC handlers for the LMCODE desktop app.
 */
export function registerAllHandlers(
  harness: LmcodeHarness,
  mainWindow: BrowserWindow,
): void {
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
    const existing = activeSessions.get(sessionId)
    if (existing) return existing

    const inflight = resumingSessions.get(sessionId)
    if (inflight) return inflight

    const pending = (async (): Promise<SessionEntry> => {
      const session = await harness.resumeSession({ id: sessionId })
      setupSessionListeners(session, mainWindow)
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

  ipcMain.handle('lmcode:createSession', async (_event, opts: {
    workDir: string
    model?: string
    thinking?: string
    permission?: 'yolo' | 'manual' | 'auto'
  }): Promise<SessionSummary | undefined> => {
    // The SDK requires a real working directory. The desktop UI does not yet
    // expose a project picker, so fall back to the user's home directory.
    const workDir = opts.workDir?.trim() ? opts.workDir : app.getPath('home')
    const session = await harness.createSession({ ...opts, workDir })
    setupSessionListeners(session, mainWindow)
    return session.summary
  })

  ipcMain.handle('lmcode:resumeSession', async (_event, id: string): Promise<{
    summary: SessionSummary
    resumeState: ResumedSessionState | undefined
  }> => {
    const session = await harness.resumeSession({ id })
    setupSessionListeners(session, mainWindow)
    return {
      summary: session.summary!,
      resumeState: session.getResumeState(),
    }
  })

  ipcMain.handle('lmcode:deleteSession', async (_event, id: string): Promise<void> => {
    const entry = activeSessions.get(id)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(id)
    }
    await harness.deleteSession(id)
  })

  ipcMain.handle('lmcode:listSessions', async (): Promise<readonly SessionSummary[]> => {
    return harness.listSessions()
  })

  ipcMain.handle('lmcode:renameSession', async (_event, id: string, title: string): Promise<void> => {
    await harness.renameSession({ id, title })
  })

  // ── Chat ────────────────────────────────────────────────────────

  ipcMain.handle('lmcode:sendMessage', async (_event, sessionId: string, text: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.prompt(text)
  })

  ipcMain.handle('lmcode:cancelResponse', async (_event, sessionId: string): Promise<void> => {
    const entry = activeSessions.get(sessionId)
    if (!entry) throw new Error(`Session "${sessionId}" not found`)
    await entry.session.cancel()
  })

  // Return the persisted conversation history so the UI can re-render a session's
  // messages after a restart or when switching back to it.
  ipcMain.handle('lmcode:getSessionHistory', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    const ctx = await entry.session.getContext()
    return ctx.history
  })

  // ── Session control ─────────────────────────────────────────────

  ipcMain.handle('lmcode:setModel', async (_event, sessionId: string, model: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setModel(model)
  })

  ipcMain.handle('lmcode:setThinking', async (_event, sessionId: string, level: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setThinking(level)
  })

  ipcMain.handle('lmcode:setPermission', async (_event, sessionId: string, mode: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.setPermission(mode as 'yolo' | 'manual' | 'auto')
  })

  ipcMain.handle('lmcode:closeSession', async (_event, sessionId: string): Promise<void> => {
    const entry = activeSessions.get(sessionId)
    if (entry) {
      entry.unsubscribeEvent()
      activeSessions.delete(sessionId)
    }
    await harness.closeSession(sessionId)
  })

  // ── Skills ──────────────────────────────────────────────────────

  ipcMain.handle('lmcode:listSkills', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listSkills()
  })

  ipcMain.handle('lmcode:activateSkill', async (_event, sessionId: string, name: string, args?: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.activateSkill(name, args)
  })

  // ── MCP servers ─────────────────────────────────────────────────

  ipcMain.handle('lmcode:listMcpServers', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ensureActiveSession(sessionId)
    return entry.session.listMcpServers()
  })

  ipcMain.handle('lmcode:reconnectMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.reconnectMcpServer(name)
  })

  ipcMain.handle('lmcode:addMcpServer', async (_event, sessionId: string, name: string, config: Record<string, unknown>): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.addMcpServer(name, config)
  })

  ipcMain.handle('lmcode:stopMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.stopMcpServer(name)
  })

  ipcMain.handle('lmcode:removeMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ensureActiveSession(sessionId)
    await entry.session.removeMcpServer(name)
  })

  // ── Config ──────────────────────────────────────────────────────

  ipcMain.handle('lmcode:getConfig', async (): Promise<unknown> => {
    return harness.getConfig()
  })

  ipcMain.handle('lmcode:setConfig', async (_event, patch: unknown): Promise<unknown> => {
    return harness.setConfig(patch as any)
  })

  // ── File operations ─────────────────────────────────────────────

  ipcMain.handle('lmcode:readFileContent', async (_event, filePath: string): Promise<string> => {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return content
  })

  // ── Version ─────────────────────────────────────────────────────

  ipcMain.handle('lmcode:getVersion', (): string => {
    return '0.1.0'
  })

  // ── Misc ────────────────────────────────────────────────────────

  ipcMain.handle('lmcode:getHomeDir', (): string => {
    return harness.homeDir
  })

  // ── Approval / Question responses (fire-and-forget from renderer) ─

  ipcMain.on('lmcode:respondApproval', (_event, payload: {
    sessionId: string
    requestId: string
    decision: any
  }) => {
    const pending = pendingApprovals.get(payload.requestId)
    if (pending) {
      pending.resolve(payload.decision as ApprovalResponse)
      pendingApprovals.delete(payload.requestId)
    }
  })

  ipcMain.on('lmcode:respondQuestion', (_event, payload: {
    sessionId: string
    requestId: string
    answers: any
  }) => {
    const pending = pendingQuestions.get(payload.requestId)
    if (pending) {
      pending.resolve(payload.answers as QuestionResult)
      pendingQuestions.delete(payload.requestId)
    }
  })

  // ── App control ─────────────────────────────────────────────────

  ipcMain.on('lmcode:quit', () => {
    app.quit()
  })

  // ── Memory store ───────────────────────────────────────────────

  // Share the user's existing memory store (~/.lmcode/memory), same dir as the
  // shared config, so the desktop sees the memories the CLI recorded.
  const memoryStore = new MemoryMemoStore(dirname(harness.configPath))

  ipcMain.handle('lmcode:listMemories', async (): Promise<any[]> => {
    const result = await memoryStore.list({ limit: 100 })
    return result.memos as any[]
  })

  ipcMain.handle('lmcode:searchMemories', async (_event, query: string): Promise<any[]> => {
    const result = await memoryStore.list({ search: query, limit: 20 })
    return result.memos as any[]
  })

  ipcMain.handle('lmcode:deleteMemory', async (_event, id: string): Promise<void> => {
    await memoryStore.delete(id)
  })

  // ── Background task operations ─────────────────────────────────

  ipcMain.handle('lmcode:stopTask', async (_event, taskId: string): Promise<void> => {
    for (const [_sid, entry] of activeSessions) {
      try {
        await (entry.session as any).stopBackground?.({ taskId })
        return
      } catch {
        // Session doesn't support this method
      }
    }
    throw new Error(`Task "${taskId}" not found or cannot be stopped`)
  })

  ipcMain.handle('lmcode:getTaskOutput', async (_event, taskId: string): Promise<string> => {
    for (const [_sid, entry] of activeSessions) {
      try {
        const output = (entry.session as any).getBackgroundOutput?.({ taskId })
        if (output !== undefined) return String(output)
      } catch {
        // Session doesn't support this method
      }
    }
    return ''
  })

  // ── Cleanup on window close ─────────────────────────────────────

  mainWindow.on('closed', () => {
    // Clean up all sessions
    for (const [id, entry] of activeSessions) {
      entry.unsubscribeEvent()
    }
    activeSessions.clear()
    pendingApprovals.clear()
    pendingQuestions.clear()
  })
}
