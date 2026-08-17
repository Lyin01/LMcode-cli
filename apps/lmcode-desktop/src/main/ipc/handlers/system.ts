import { app } from 'electron'
import type { MemoryMemoSummary } from '@lmcode/memory'
import type { ApprovalResponse, QuestionResult } from '@lmcode-cli/lmcode-sdk'
import type { DesktopNotificationPayload } from '../../../shared/ipc-types.js'
import type { RemoteState } from '../../../shared/remote-types.js'
import type { ProjectTerminalInfo } from '../../../shared/terminal-types.js'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * System-level surfaces that are not tied to a live session: project
 * terminal, version/home/misc queries, approval/question responses, remote
 * service control, app control, desktop notifications and the memory store.
 */
export function registerSystemHandlers(ctx: DesktopHandlerContext): void {
  const { harness, secureInvoke } = ctx

  // ── Project terminal ────────────────────────────────────────────

  secureInvoke(
    'lmcode:startTerminal',
    async (_event, sessionId: string): Promise<ProjectTerminalInfo> => {
      return ctx.terminalManager.start(sessionId, await ctx.getSessionWorkDir(sessionId))
    },
  )

  secureInvoke(
    'lmcode:writeTerminal',
    (_event, sessionId: string, input: string): void => {
      ctx.terminalManager.write(sessionId, input)
    },
  )

  secureInvoke(
    'lmcode:stopTerminal',
    async (_event, sessionId: string): Promise<void> => {
      await ctx.terminalManager.stop(sessionId)
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
    return ctx.resolveNoProjectWorkDir()
  })

  // ── Approval / Question responses ──────────────────────────────

  secureInvoke('lmcode:respondApproval', (_event, payload: {
    requestId: string
    response: ApprovalResponse
  }): void => {
    if (!ctx.interactionHub.respondApproval(payload.requestId, payload.response)) {
      throw new Error(`Approval request "${payload.requestId}" is no longer pending`)
    }
  })

  secureInvoke('lmcode:respondQuestion', (_event, payload: {
    requestId: string
    result: QuestionResult
  }): void => {
    if (!ctx.interactionHub.respondQuestion(payload.requestId, payload.result)) {
      throw new Error(`Question request "${payload.requestId}" is no longer pending`)
    }
  })

  // ── Remote service (settings panel control) ──────────────────────

  if (ctx.remoteController !== undefined) {
    const remote = ctx.remoteController
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

    secureInvoke('lmcode:setRemoteAppUrl', async (_event, appUrl: unknown): Promise<RemoteState> => {
      if (typeof appUrl !== 'string') throw new Error('Invalid app URL')
      return remote.setAppUrl(appUrl)
    })
  }

  // ── App control ─────────────────────────────────────────────────

  ctx.secureOn('lmcode:quit', () => {
    app.quit()
  })

  // ── Desktop notifications ──────────────────────────────────────

  // Renderer-originated notifications (currently: a background session's
  // turn finished). The renderer sees everything while the window is
  // focused, so only escalate to the OS when the user is looking
  // elsewhere. Approval notifications keep their own main-side path.
  ctx.secureOn('lmcode:sendNotification', (_event, payload: DesktopNotificationPayload) => {
    if (ctx.mainWindow.isDestroyed() || ctx.mainWindow.isFocused()) return
    if (payload?.kind !== 'turn-completed' || typeof payload.title !== 'string') return
    const title = payload.title.trim().slice(0, 120) || '新任务'
    const body = (payload.body ?? '后台任务的回合已完成').slice(0, 200)
    ctx.sendNotification(`LMCODE - ${title}`, body)
  })

  // ── Memory store ───────────────────────────────────────────────

  secureInvoke('lmcode:listMemories', async (): Promise<MemoryMemoSummary[]> => {
    const result = await ctx.memoryStore.list({ limit: 100 })
    return result.memos
  })

  secureInvoke('lmcode:searchMemories', async (_event, query: string): Promise<MemoryMemoSummary[]> => {
    const result = await ctx.memoryStore.list({ search: query, limit: 20 })
    return result.memos
  })

  secureInvoke('lmcode:deleteMemory', async (_event, id: string): Promise<void> => {
    await ctx.memoryStore.delete(id)
    ctx.auditLog?.info('desktop critical operation completed', {
      operation: 'memory.delete',
    })
  })
}
