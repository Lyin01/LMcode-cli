import { app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import type {
  ResumedSessionState,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'
import type { DesktopCreateSessionOptions } from '../../../shared/ipc-types.js'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * Session lifecycle: create, resume, delete, export, rename, list, and the
 * work-directory picker. Closing a session also tears down its terminal and
 * settles any pending interactions.
 */
export function registerSessionHandlers(ctx: DesktopHandlerContext): void {
  const { harness, secureInvoke } = ctx

  secureInvoke('lmcode:createSession', async (_event, opts: DesktopCreateSessionOptions): Promise<SessionSummary> => {
    const requestedWorkDir = opts.workDir?.trim() ?? ''
    if (opts.noProject === true && requestedWorkDir) {
      throw new Error('A no-project session cannot also specify a project directory')
    }
    const workDir = opts.noProject === true ? ctx.resolveNoProjectWorkDir() : requestedWorkDir
    if (!workDir) {
      throw new Error('A project directory is required to create a desktop session')
    }
    const session = await harness.createSession({
      workDir,
      model: opts.model,
      thinking: opts.thinking,
      permission: opts.permission,
    })
    ctx.setupSessionListeners(session)
    if (!session.summary) {
      throw new Error('The desktop session was created without a summary')
    }
    ctx.auditLog?.info('desktop critical operation completed', {
      operation: 'session.create',
    })
    return session.summary
  })

  secureInvoke(
    'lmcode:selectWorkDirectory',
    async (_event, initialDirectory?: string): Promise<string | undefined> => {
      const result = await dialog.showOpenDialog(ctx.mainWindow, {
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
    const { session } = await ctx.ensureActiveSession(id)
    if (!session.summary) {
      throw new Error(`Session "${id}" resumed without a summary`)
    }
    return {
      summary: session.summary,
      resumeState: session.getResumeState(),
    }
  })

  secureInvoke('lmcode:deleteSession', async (_event, id: string): Promise<void> => {
    await ctx.terminalManager.stop(id)
    // A resume still in flight for this session would re-attach it to
    // activeSessions after the delete (the SDK reads the store once at the
    // start of resumeSession, so it cannot observe a mid-flight deletion).
    // Let it settle first so the delete below unregisters the session.
    const inflightResume = ctx.resumingSessions.get(id)
    if (inflightResume) await inflightResume.catch(() => {})
    const entry = ctx.activeSessions.get(id)
    if (entry) {
      entry.unsubscribeEvent()
      ctx.activeSessions.delete(id)
    }
    ctx.interactionHub.settleSession(id)
    try {
      await harness.deleteSession(id)
      ctx.auditLog?.info('desktop critical operation completed', {
        operation: 'session.delete',
      })
    } finally {
      ctx.interactionHub.settleSession(id)
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
      const result = await dialog.showSaveDialog(ctx.mainWindow, {
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

  secureInvoke('lmcode:closeSession', async (_event, sessionId: string): Promise<void> => {
    await ctx.terminalManager.stop(sessionId)
    const entry = ctx.activeSessions.get(sessionId)
    if (entry) {
      entry.unsubscribeEvent()
      ctx.activeSessions.delete(sessionId)
    }
    ctx.interactionHub.settleSession(sessionId)
    try {
      await harness.closeSession(sessionId)
    } finally {
      ctx.interactionHub.settleSession(sessionId)
    }
  })
}
