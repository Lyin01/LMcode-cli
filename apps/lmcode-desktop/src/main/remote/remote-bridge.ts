import os from 'node:os'
import type {
  LmcodeHarness,
  ResumedSessionState,
  Session,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'
import type { MemoryMemoStore } from '@lmcode/memory'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import { restoreRedactedConfigPatch, sanitizeConfigForRenderer } from '../config-security.js'
import { isPermissionMode } from '../../shared/permission-mode.js'
import type {
  RemoteMethod,
  RemoteMethodResult,
  RemoteRequestParams,
  RemoteServerMessage,
  RemoteSystemInfo,
} from '../../shared/remote-types.js'
import type { InteractionHub, InteractionSurface } from './interaction-hub.js'

export interface RemoteConnection {
  /** Send one wire message to the client. Must not throw on a closed socket. */
  send(message: RemoteServerMessage): void
  /** True while the underlying socket is open. */
  readonly isOpen: boolean
}

interface ActiveSessionEntry {
  readonly session: Session
  readonly unsubscribeEvent: () => void
}

function requireString(
  params: Record<string, unknown>,
  key: string,
  method: string,
): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Remote method "${method}": missing required string parameter "${key}"`)
  }
  return value.trim()
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function requireBoolean(
  params: Record<string, unknown>,
  key: string,
  method: string,
): boolean {
  const value = params[key]
  if (typeof value !== 'boolean') {
    throw new Error(`Remote method "${method}": missing required boolean parameter "${key}"`)
  }
  return value
}

function requireObject(
  params: Record<string, unknown>,
  key: string,
  method: string,
): Record<string, unknown> {
  const value = params[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Remote method "${method}": missing required object parameter "${key}"`)
  }
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Bridges remote client requests to the SDK. Owns:
 *
 * - method dispatch (`invoke`) for the protocol catalog in `remote-types.ts`;
 * - per-session event forwarding from SDK events to every connected client;
 * - an `InteractionSurface` on the shared hub, so approvals/questions raised
 *   by a session reach remote clients (and vice versa: the desktop renderer
 *   and remote clients are surfaces of the same hub, first responder wins).
 *
 * The surface is deliberately read-only + chat/control: no file access, no
 * project terminal, no Git writes and no app quit.
 */
export class RemoteBridge implements InteractionSurface {
  readonly name = 'remote'

  private readonly connections = new Set<RemoteConnection>()
  private readonly activeSessions = new Map<string, ActiveSessionEntry>()
  private readonly resumingSessions = new Map<string, Promise<ActiveSessionEntry>>()
  private readonly memoryStore: MemoryMemoStore
  private closing = false

  constructor(
    private readonly harness: LmcodeHarness,
    private readonly hub: InteractionHub,
    private readonly noProjectWorkDir: string,
    memoryStore: MemoryMemoStore,
  ) {
    this.memoryStore = memoryStore
    hub.attachSurface(this)
  }

  get clientCount(): number {
    return this.connections.size
  }

  attachConnection(connection: RemoteConnection): void {
    this.connections.add(connection)
  }

  detachConnection(connection: RemoteConnection): void {
    this.connections.delete(connection)
  }

  // ── InteractionSurface (approvals / questions from sessions) ───────

  sendApproval(payload: {
    readonly sessionId: string
    readonly requestId: string
    readonly request: import('@lmcode-cli/lmcode-sdk').ApprovalRequest
  }): boolean {
    return this.broadcast({
      type: 'approval',
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      request: payload.request,
    })
  }

  sendQuestion(payload: {
    readonly sessionId: string
    readonly requestId: string
    readonly request: import('@lmcode-cli/lmcode-sdk').QuestionRequest
  }): boolean {
    return this.broadcast({
      type: 'question',
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      request: payload.request,
    })
  }

  notifySettled(payload: {
    readonly sessionId: string
    readonly requestId: string
  }): void {
    this.broadcast({
      type: 'settled',
      sessionId: payload.sessionId,
      requestId: payload.requestId,
    })
  }

  // ── Event forwarding ───────────────────────────────────────────────

  private broadcastEvent(sessionId: string, event: Event): void {
    this.broadcast({ type: 'event', sessionId, event })
  }

  private broadcast(message: RemoteServerMessage): boolean {
    let delivered = false
    for (const connection of this.connections) {
      if (!connection.isOpen) continue
      connection.send(message)
      delivered = true
    }
    return delivered
  }

  /**
   * Resume a session in this bridge and start forwarding its events. Safe to
   * call concurrently: in-flight resumes are deduplicated by promise.
   */
  async ensureSession(sessionId: string): Promise<Session> {
    const existing = this.activeSessions.get(sessionId)
    if (existing !== undefined) return existing.session

    const inflight = this.resumingSessions.get(sessionId)
    if (inflight !== undefined) return (await inflight).session

    const pending = (async (): Promise<ActiveSessionEntry> => {
      const session = await this.harness.resumeSession({ id: sessionId })
      const unsubscribeEvent = session.onEvent((event: Event) =>
        this.broadcastEvent(sessionId, event),
      )
      const entry: ActiveSessionEntry = { session, unsubscribeEvent }
      this.activeSessions.set(sessionId, entry)
      return entry
    })()
    this.resumingSessions.set(sessionId, pending)
    try {
      return (await pending).session
    } finally {
      this.resumingSessions.delete(sessionId)
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const inflight = this.resumingSessions.get(sessionId)
    if (inflight !== undefined) await inflight.catch(() => undefined)
    const entry = this.activeSessions.get(sessionId)
    if (entry !== undefined) {
      entry.unsubscribeEvent()
      this.activeSessions.delete(sessionId)
    }
    this.hub.settleSession(sessionId)
    await this.harness.closeSession(sessionId)
  }

  // ── Method dispatch ────────────────────────────────────────────────

  async invoke<M extends RemoteMethod>(
    method: M,
    rawParams: RemoteRequestParams,
  ): Promise<RemoteMethodResult<M>> {
    if (this.closing) throw new Error('Remote bridge is closed')
    const params = (isRecord(rawParams) ? rawParams : {}) as Record<string, unknown>
    switch (method) {
      case 'system.info':
        return this.systemInfo() as RemoteMethodResult<M>

      // sessions
      case 'sessions.list':
        return this.harness.listSessions() as RemoteMethodResult<M>
      case 'sessions.projects':
        return this.listProjects() as RemoteMethodResult<M>
      case 'sessions.create':
        return this.createSession(params) as RemoteMethodResult<M>
      case 'sessions.resume':
        return this.resumeSession(requireString(params, 'id', method)) as RemoteMethodResult<M>
      case 'sessions.delete':
        await this.deleteSession(requireString(params, 'id', method))
        return undefined as RemoteMethodResult<M>
      case 'sessions.rename':
        await this.harness.renameSession({
          id: requireString(params, 'id', method),
          title: requireString(params, 'title', method),
        })
        return undefined as RemoteMethodResult<M>
      case 'sessions.close':
        await this.closeSession(requireString(params, 'id', method))
        return undefined as RemoteMethodResult<M>
      case 'sessions.history':
        return (await (await this.ensureSession(requireString(params, 'id', method))).getContext())
          .history as RemoteMethodResult<M>
      case 'sessions.status':
        return (await this.ensureSession(requireString(params, 'id', method))).getStatus() as RemoteMethodResult<M>

      // chat
      case 'chat.send': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const text = requireString(params, 'text', method)
        this.rejectAttachments(params, method)
        await session.prompt(text)
        return undefined as RemoteMethodResult<M>
      }
      case 'chat.steer': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const text = requireString(params, 'text', method)
        this.rejectAttachments(params, method)
        await session.steer(text)
        return undefined as RemoteMethodResult<M>
      }
      case 'chat.cancel': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        this.hub.settleSession(session.id)
        try {
          await session.cancel()
        } finally {
          this.hub.settleSession(session.id)
        }
        return undefined as RemoteMethodResult<M>
      }

      // session control
      case 'control.model': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.setModel(requireString(params, 'model', method))
        return undefined as RemoteMethodResult<M>
      }
      case 'control.thinking': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.setThinking(requireString(params, 'level', method))
        return undefined as RemoteMethodResult<M>
      }
      case 'control.permission': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const mode = requireString(params, 'mode', method)
        if (!isPermissionMode(mode)) throw new Error('Invalid permission mode')
        await session.setPermission(mode)
        return undefined as RemoteMethodResult<M>
      }
      case 'control.planMode': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.setPlanMode(requireBoolean(params, 'enabled', method))
        return undefined as RemoteMethodResult<M>
      }
      case 'control.goal.get': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.getGoal() as RemoteMethodResult<M>
      }
      case 'control.goal.create': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const replace = params['replace']
        const goalOptions = replace === undefined ? {} : { replace: replace === true }
        return session.createGoal(requireString(params, 'objective', method), goalOptions) as RemoteMethodResult<M>
      }
      case 'control.goal.status': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const status = requireString(params, 'status', method) as
          | 'active'
          | 'complete'
          | 'paused'
          | 'blocked'
        if (!['active', 'complete', 'paused', 'blocked'].includes(status)) {
          throw new Error('Invalid goal status')
        }
        return session.updateGoalStatus(status) as RemoteMethodResult<M>
      }
      case 'control.goal.cancel': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.cancelGoal() as RemoteMethodResult<M>
      }

      // automations
      case 'cron.list': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.listCronJobs() as RemoteMethodResult<M>
      }
      case 'cron.create': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const recurring = params['recurring']
        return session.createCronJob({
          cron: requireString(params, 'cron', method),
          prompt: requireString(params, 'prompt', method),
          ...(recurring === undefined ? {} : { recurring: recurring === true }),
        }) as RemoteMethodResult<M>
      }
      case 'cron.delete': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.deleteCronJob(requireString(params, 'id', method))
        return undefined as RemoteMethodResult<M>
      }

      // background tasks
      case 'tasks.list': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.listBackgroundTasks({ activeOnly: false }) as RemoteMethodResult<M>
      }
      case 'tasks.stop': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.stopBackgroundTask(requireString(params, 'taskId', method), {
          reason: 'Stopped from LMCODE Remote',
        })
        return undefined as RemoteMethodResult<M>
      }
      case 'tasks.output': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.getBackgroundTaskOutput(
          requireString(params, 'taskId', method),
        ) as RemoteMethodResult<M>
      }

      // skills
      case 'skills.list': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.listSkills() as RemoteMethodResult<M>
      }
      case 'skills.activate': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        const args = optionalString(params, 'args')
        await session.activateSkill(requireString(params, 'name', method), args)
        return undefined as RemoteMethodResult<M>
      }

      // MCP
      case 'mcp.list': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        return session.listMcpServers() as RemoteMethodResult<M>
      }
      case 'mcp.reconnect': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.reconnectMcpServer(requireString(params, 'name', method))
        return undefined as RemoteMethodResult<M>
      }
      case 'mcp.add': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.addMcpServer(
          requireString(params, 'name', method),
          requireObject(params, 'config', method),
        )
        return undefined as RemoteMethodResult<M>
      }
      case 'mcp.stop': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.stopMcpServer(requireString(params, 'name', method))
        return undefined as RemoteMethodResult<M>
      }
      case 'mcp.remove': {
        const session = await this.ensureSession(requireString(params, 'sessionId', method))
        await session.removeMcpServer(requireString(params, 'name', method))
        return undefined as RemoteMethodResult<M>
      }

      // config
      case 'config.get':
        return sanitizeConfigForRenderer(await this.harness.getConfig()) as RemoteMethodResult<M>
      case 'config.set': {
        const patch = requireObject(params, 'patch', method) as never
        const current = await this.harness.getConfig()
        const config = await this.harness.setConfig(restoreRedactedConfigPatch(patch, current))
        return sanitizeConfigForRenderer(config) as RemoteMethodResult<M>
      }

      // memory
      case 'memory.list':
        return (await this.memoryStore.list({ limit: 100 })).memos as RemoteMethodResult<M>
      case 'memory.search':
        return (
          await this.memoryStore.list({ search: requireString(params, 'query', method), limit: 20 })
        ).memos as RemoteMethodResult<M>
      case 'memory.delete':
        await this.memoryStore.delete(requireString(params, 'id', method))
        return undefined as RemoteMethodResult<M>

      default:
        throw new Error(`Unknown remote method: ${String(method)}`)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.hub.detachSurface(this.name)
    this.connections.clear()
    for (const entry of this.activeSessions.values()) {
      entry.unsubscribeEvent()
    }
    this.activeSessions.clear()
    // The memory store is owned by the app lifecycle (shared with the desktop
    // IPC handlers); this bridge only borrows it and must not close it.
  }

  // ── Private helpers ────────────────────────────────────────────────

  private systemInfo(): RemoteSystemInfo {
    return {
      version: 'desktop',
      platform: process.platform,
      hostname: os.hostname(),
    }
  }

  private async listProjects(): Promise<readonly string[]> {
    const sessions = await this.harness.listSessions()
    const seen = new Set<string>()
    const projects: string[] = []
    for (const summary of sessions) {
      const workDir = summary.workDir
      if (workDir !== undefined && workDir.length > 0 && !seen.has(workDir)) {
        seen.add(workDir)
        projects.push(workDir)
      }
    }
    return projects
  }

  private async createSession(
    params: Record<string, unknown>,
  ): Promise<SessionSummary> {
    const session =
      params['noProject'] === true
        ? await this.harness.createSession({ workDir: this.noProjectWorkDir })
        : await this.harness.createSession({
            workDir: requireString(params, 'workDir', 'sessions.create'),
          })
    if (!session.summary) {
      throw new Error('Remote session created without a summary')
    }
    return session.summary
  }

  private async resumeSession(id: string): Promise<{
    readonly summary: SessionSummary
    readonly resumeState: ResumedSessionState | undefined
  }> {
    const session = await this.ensureSession(id)
    if (!session.summary) {
      throw new Error(`Remote session "${id}" resumed without a summary`)
    }
    return {
      summary: session.summary,
      resumeState: session.getResumeState(),
    }
  }

  private async deleteSession(id: string): Promise<void> {
    const inflight = this.resumingSessions.get(id)
    if (inflight !== undefined) await inflight.catch(() => undefined)
    const entry = this.activeSessions.get(id)
    if (entry !== undefined) {
      entry.unsubscribeEvent()
      this.activeSessions.delete(id)
    }
    this.hub.settleSession(id)
    await this.harness.deleteSession(id)
  }

  private rejectAttachments(params: Record<string, unknown>, method: string): void {
    const attachments = params['attachments']
    if (Array.isArray(attachments) && attachments.length > 0) {
      throw new Error(`Remote method "${method}": file/image attachments are not supported`)
    }
  }
}
