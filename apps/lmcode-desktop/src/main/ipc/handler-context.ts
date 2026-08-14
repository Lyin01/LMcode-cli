import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow } from 'electron'
import type { MemoryMemoStore } from '@lmcode/memory'
import type {
  LmcodeHarness,
  Logger,
  Session,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'
import type { GitWorktreeInfo } from '../../shared/worktree-types.js'
import type { RemoteState } from '../../shared/remote-types.js'
import type { InteractionHub } from '../remote/interaction-hub.js'
import type { ProjectTerminalManager } from '../project-terminal.js'
import type { ProviderUsageService } from '../provider-usage.js'

export interface SessionEntry {
  session: Session
  unsubscribeEvent: () => void
}

/** Registers a request/response IPC channel with the closing gate + sender check. */
export type SecureInvoke = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
) => void

/** Registers a fire-and-forget IPC channel with the closing gate + sender check. */
export type SecureOn = <Args extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: Args) => void,
) => void

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
  setAppUrl(appUrl: string): Promise<RemoteState>
}

/**
 * Shared state handed to every domain-level IPC handler module. The context is
 * assembled once inside {@link registerAllHandlers}; domain modules register
 * their channels through `secureInvoke` / `secureOn` and read shared session
 * state through the accessors below.
 */
export interface DesktopHandlerContext {
  harness: LmcodeHarness
  mainWindow: BrowserWindow
  /** Human label used for audit-log scoping. */
  auditLog: Logger | undefined
  /**
   * Registers a request/response IPC channel with the renderer. Applies the
   * closing gate and trusted-sender check, then audits failures.
   */
  secureInvoke: SecureInvoke
  /** Registers a fire-and-forget IPC channel (closing gate + sender check). */
  secureOn: SecureOn
  /** Resumes the session on demand and returns its live entry. */
  ensureActiveSession(sessionId: string): Promise<SessionEntry>
  /** Resolves a session's project directory (resuming it if needed). */
  getSessionWorkDir(sessionId: string): Promise<string>
  /** Attaches event forwarding and reverse-RPC handlers to a live session. */
  setupSessionListeners(session: Session): void
  /** Currently live sessions (main agent + subagents) by id. */
  activeSessions: Map<string, SessionEntry>
  /** In-flight session resumes, keyed by id. */
  resumingSessions: Map<string, Promise<SessionEntry>>
  /** Directories whose contents must never leak through chat/file IPC. */
  credentialRoots: readonly string[]
  /** Fan-out hub for approval/question reverse-RPC requests. */
  interactionHub: InteractionHub
  terminalManager: ProjectTerminalManager
  providerUsage: ProviderUsageService
  memoryStore: MemoryMemoStore
  /** Main-process-owned workspace used for `noProject` sessions. */
  resolveNoProjectWorkDir(): string
  /** Forks a session into a git worktree and wires up the new session. */
  forkSessionIntoWorktree(sessionId: string, worktree: GitWorktreeInfo): Promise<SessionSummary>
  /** Optional remote-service controller; absent when the remote is disabled. */
  remoteController: RemoteController | undefined
  /** Shows a native desktop notification (approval, turn completed, …). */
  sendNotification(title: string, body: string): void
}
