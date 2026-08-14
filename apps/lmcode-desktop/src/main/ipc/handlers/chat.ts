import type {
  GoalSnapshotData,
  SessionStatus,
} from '@lmcode-cli/lmcode-sdk'
import { buildDesktopPromptInput } from '../../file-attachment.js'
import type { DesktopPromptRequest } from '../../../shared/file-types.js'
import { isPermissionMode } from '../../../shared/permission-mode.js'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * Chat messaging and per-session control: send/steer/cancel, history and
 * status, model/thinking/permission, goals, plan mode, compaction and undo.
 */
export function registerChatHandlers(ctx: DesktopHandlerContext): void {
  const { secureInvoke } = ctx

  secureInvoke(
    'lmcode:sendMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.prompt(await buildDesktopPromptInput(request, ctx.credentialRoots))
    },
  )

  secureInvoke(
    'lmcode:steerMessage',
    async (_event, sessionId: string, request: DesktopPromptRequest): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.steer(await buildDesktopPromptInput(request, ctx.credentialRoots))
    },
  )

  secureInvoke('lmcode:cancelResponse', async (_event, sessionId: string): Promise<void> => {
    ctx.interactionHub.settleSession(sessionId)
    const entry = ctx.activeSessions.get(sessionId)
    if (!entry) throw new Error(`Session "${sessionId}" not found`)
    try {
      await entry.session.cancel()
    } finally {
      // Cancellation can itself race a new reverse-RPC request. Sweep again
      // after the SDK has finished unwinding the active turn.
      ctx.interactionHub.settleSession(sessionId)
    }
  })

  // Return the persisted conversation history so the UI can re-render a session's
  // messages after a restart or when switching back to it.
  secureInvoke('lmcode:getSessionHistory', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    const sessionCtx = await entry.session.getContext()
    return sessionCtx.history
  })

  secureInvoke(
    'lmcode:getSessionStatus',
    async (_event, sessionId: string): Promise<SessionStatus> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.getStatus()
    },
  )

  secureInvoke('lmcode:setModel', async (_event, sessionId: string, model: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.setModel(model)
  })

  secureInvoke('lmcode:setThinking', async (_event, sessionId: string, level: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.setThinking(level)
  })

  secureInvoke('lmcode:setPermission', async (_event, sessionId: string, mode: unknown): Promise<void> => {
    if (!isPermissionMode(mode)) throw new Error('Invalid permission mode')
    const entry = await ctx.ensureActiveSession(sessionId)
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
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.createGoal(objective, { replace })
    },
  )

  secureInvoke(
    'lmcode:getGoal',
    async (_event, sessionId: string): Promise<{ readonly goal: GoalSnapshotData | null }> => {
      const entry = await ctx.ensureActiveSession(sessionId)
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
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.updateGoalStatus(status)
    },
  )

  secureInvoke(
    'lmcode:cancelGoal',
    async (_event, sessionId: string): Promise<GoalSnapshotData | null> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.cancelGoal()
    },
  )

  secureInvoke(
    'lmcode:setPlanMode',
    async (_event, sessionId: string, enabled: boolean): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.setPlanMode(enabled)
    },
  )

  secureInvoke(
    'lmcode:compactSession',
    async (_event, sessionId: string, instruction?: string): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.compact({ instruction })
    },
  )

  secureInvoke(
    'lmcode:undoHistory',
    async (_event, sessionId: string, count: number): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.undoHistory(count)
    },
  )
}
