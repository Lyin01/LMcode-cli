import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CronJobInfo,
  Event,
  GoalSnapshotData,
  LmcodeConfig,
  LmcodeConfigPatch,
  McpServerInfo,
  QuestionRequest,
  QuestionResult,
  ResumedSessionState,
  SessionStatus,
  SessionSummary,
  SkillSummary,
} from '@lmcode-cli/lmcode-sdk'
import type { MemoryMemoSummary } from '@lmcode/memory'

// ── Remote service state ──────────────────────────────────────────────

/**
 * Persisted remote-service configuration (stored in `userData/remote-config.json`).
 * The service is opt-in: it is OFF by default and only starts after the user
 * enables it from the desktop settings panel.
 */
export interface RemoteConfig {
  enabled: boolean
  port: number
  token: string
}

/**
 * Snapshot of the remote service pushed to the desktop renderer and to every
 * connected client whenever the service starts, stops or changes.
 */
export interface RemoteState extends RemoteConfig {
  lanUrls: string[]
  clientCount: number
  version: string
}

export interface RemoteSystemInfo {
  version: string
  platform: string
  hostname: string
}

// ── Wire protocol (WebSocket JSON messages) ───────────────────────────
//
// The desktop (server) and the remote app (client) speak this protocol over
// a single WebSocket connection. The client must authenticate with the first
// message it sends (`auth`); the server drops the connection otherwise and
// confirms success with `auth-ok`.
//
// Client → server:  auth | request | approval | question | ping
// Server → client:  auth-ok | response | event | approval | question |
//                   settled | server-state | pong

/** Client hello with the pairing token. Must be the first message. */
export interface RemoteAuthMessage {
  readonly type: 'auth'
  readonly token: string
}

/**
 * Server confirmation that authentication succeeded. After this message the
 * client is connected and may issue `request` messages.
 */
export interface RemoteAuthOkMessage {
  readonly type: 'auth-ok'
  readonly state: RemoteState
}

/** One method call. The reply is matched by `id`. */
export interface RemoteRequestMessage {
  readonly type: 'request'
  readonly id: string
  readonly method: string
  readonly params: RemoteRequestParams
}

/** Client-side settlement of an approval pushed by the server. */
export interface RemoteApprovalResponseMessage {
  readonly type: 'approval'
  readonly requestId: string
  readonly response: ApprovalResponse
}

/** Client-side settlement of a question pushed by the server. */
export interface RemoteQuestionResponseMessage {
  readonly type: 'question'
  readonly requestId: string
  readonly result: QuestionResult
}

export interface RemotePingMessage {
  readonly type: 'ping'
  readonly t: number
}

export type RemoteClientMessage =
  | RemoteAuthMessage
  | RemoteRequestMessage
  | RemoteApprovalResponseMessage
  | RemoteQuestionResponseMessage
  | RemotePingMessage

/** Server reply to a `request` message (matched by `id`). */
export interface RemoteResponseMessage {
  readonly type: 'response'
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

/** Session event stream (same events the desktop renderer receives). */
export interface RemoteEventMessage {
  readonly type: 'event'
  readonly sessionId: string
  readonly event: Event
}

/** Approval request pushed to the client for the user to decide. */
export interface RemoteApprovalMessage {
  readonly type: 'approval'
  readonly sessionId: string
  readonly requestId: string
  readonly request: ApprovalRequest
}

/** Structured question pushed to the client for the user to answer. */
export interface RemoteQuestionMessage {
  readonly type: 'question'
  readonly sessionId: string
  readonly requestId: string
  readonly request: QuestionRequest
}

/** The request was already settled by another client (or cancelled). */
export interface RemoteSettledMessage {
  readonly type: 'settled'
  readonly sessionId: string
  readonly requestId: string
}

/** Service state changed (client count, enabled, ...). */
export interface RemoteServerStateMessage {
  readonly type: 'server-state'
  readonly state: RemoteState
}

export interface RemotePongMessage {
  readonly type: 'pong'
  readonly t: number
}

export type RemoteServerMessage =
  | RemoteAuthOkMessage
  | RemoteResponseMessage
  | RemoteEventMessage
  | RemoteApprovalMessage
  | RemoteQuestionMessage
  | RemoteSettledMessage
  | RemoteServerStateMessage
  | RemotePongMessage

// ── Remote method catalog ─────────────────────────────────────────────
//
// The remote surface deliberately excludes file system access, the project
// terminal and Git write operations: a stolen token must not turn the desktop
// into a remote shell. Chat, session control, goals, automations, tasks,
// skills, MCP, sanitized config and memory browsing are available.

export interface RemoteGetGoalResult {
  readonly goal: GoalSnapshotData | null
}

export interface RemoteMethods {
  // system
  'system.info': { readonly params: Record<string, never>; readonly result: RemoteSystemInfo }

  // sessions
  'sessions.list': { readonly params: Record<string, never>; readonly result: readonly SessionSummary[] }
  'sessions.projects': { readonly params: Record<string, never>; readonly result: readonly string[] }
  'sessions.create': {
    readonly params: { readonly workDir?: string; readonly noProject?: boolean }
    readonly result: SessionSummary
  }
  'sessions.resume': {
    readonly params: { readonly id: string }
    readonly result: { readonly summary: SessionSummary; readonly resumeState: ResumedSessionState | undefined }
  }
  'sessions.delete': { readonly params: { readonly id: string }; readonly result: void }
  'sessions.rename': { readonly params: { readonly id: string; readonly title: string }; readonly result: void }
  'sessions.close': { readonly params: { readonly id: string }; readonly result: void }
  'sessions.history': { readonly params: { readonly id: string }; readonly result: unknown }
  'sessions.status': { readonly params: { readonly id: string }; readonly result: SessionStatus }

  // chat
  'chat.send': {
    readonly params: { readonly sessionId: string; readonly text: string; readonly attachments?: unknown[] }
    readonly result: void
  }
  'chat.steer': {
    readonly params: { readonly sessionId: string; readonly text: string; readonly attachments?: unknown[] }
    readonly result: void
  }
  'chat.cancel': { readonly params: { readonly sessionId: string }; readonly result: void }

  // session control
  'control.model': { readonly params: { readonly sessionId: string; readonly model: string }; readonly result: void }
  'control.thinking': { readonly params: { readonly sessionId: string; readonly level: string }; readonly result: void }
  'control.permission': { readonly params: { readonly sessionId: string; readonly mode: string }; readonly result: void }
  'control.planMode': { readonly params: { readonly sessionId: string; readonly enabled: boolean }; readonly result: void }
  'control.goal.get': { readonly params: { readonly sessionId: string }; readonly result: RemoteGetGoalResult }
  'control.goal.create': {
    readonly params: { readonly sessionId: string; readonly objective: string; readonly replace?: boolean }
    readonly result: GoalSnapshotData
  }
  'control.goal.status': {
    readonly params: { readonly sessionId: string; readonly status: 'active' | 'complete' | 'paused' | 'blocked' }
    readonly result: GoalSnapshotData | null
  }
  'control.goal.cancel': { readonly params: { readonly sessionId: string }; readonly result: GoalSnapshotData | null }

  // automations
  'cron.list': { readonly params: { readonly sessionId: string }; readonly result: readonly CronJobInfo[] }
  'cron.create': {
    readonly params: { readonly sessionId: string; readonly cron: string; readonly prompt: string; readonly recurring?: boolean }
    readonly result: CronJobInfo
  }
  'cron.delete': { readonly params: { readonly sessionId: string; readonly id: string }; readonly result: void }

  // background tasks
  'tasks.list': { readonly params: { readonly sessionId: string }; readonly result: readonly BackgroundTaskInfo[] }
  'tasks.stop': { readonly params: { readonly sessionId: string; readonly taskId: string }; readonly result: void }
  'tasks.output': { readonly params: { readonly sessionId: string; readonly taskId: string }; readonly result: string }

  // skills
  'skills.list': { readonly params: { readonly sessionId: string }; readonly result: readonly SkillSummary[] }
  'skills.activate': {
    readonly params: { readonly sessionId: string; readonly name: string; readonly args?: string }
    readonly result: void
  }

  // MCP
  'mcp.list': { readonly params: { readonly sessionId: string }; readonly result: readonly McpServerInfo[] }
  'mcp.reconnect': { readonly params: { readonly sessionId: string; readonly name: string }; readonly result: void }
  'mcp.add': {
    readonly params: { readonly sessionId: string; readonly name: string; readonly config: Record<string, unknown> }
    readonly result: void
  }
  'mcp.stop': { readonly params: { readonly sessionId: string; readonly name: string }; readonly result: void }
  'mcp.remove': { readonly params: { readonly sessionId: string; readonly name: string }; readonly result: void }

  // config (sanitized, same redaction rules as the desktop renderer)
  'config.get': { readonly params: Record<string, never>; readonly result: LmcodeConfig }
  'config.set': { readonly params: { readonly patch: LmcodeConfigPatch }; readonly result: LmcodeConfig }

  // memory
  'memory.list': { readonly params: Record<string, never>; readonly result: readonly MemoryMemoSummary[] }
  'memory.search': { readonly params: { readonly query: string }; readonly result: readonly MemoryMemoSummary[] }
  'memory.delete': { readonly params: { readonly id: string }; readonly result: void }
}

export type RemoteMethod = keyof RemoteMethods

/**
 * Wire params for any method, derived from the method catalog so the two
 * cannot drift apart. Servers still validate each request at runtime (the
 * wire is untrusted); this type exists for well-formed clients.
 */
export type RemoteRequestParams = RemoteMethods[RemoteMethod]['params']

export type RemoteMethodResult<M extends RemoteMethod> = RemoteMethods[M]['result']
