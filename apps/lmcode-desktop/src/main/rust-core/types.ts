import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  ComputerUseStatus,
  CronJobInfo,
  Event,
  GoalSnapshotData,
  LmcodeConfig,
  LmcodeConfigPatch,
  QuestionRequest,
  QuestionResult,
  SessionStatus,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'

import type { MemoryMemoSummary } from '@lmcode/memory'

/**
 * Methods the Electron main process and the remote bridge already call.
 * Fakes in vitest satisfy this structurally. The Rust client is the real one.
 */
export interface DesktopSession {
  readonly id: string
  readonly summary: SessionSummary | undefined
  readonly isClosed: boolean
  onEvent(listener: (event: Event) => void): () => void
  setApprovalHandler(handler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined): void
  setQuestionHandler(handler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined): void
  prompt(input: unknown): Promise<void>
  steer(input: unknown): Promise<void>
  cancel(): Promise<void>
  getContext(): Promise<{ history: unknown[] }>
  getResumeState(): undefined
  getStatus(): Promise<SessionStatus>
  setModel(model: string): Promise<void>
  setThinking(level: string): Promise<void>
  setPermission(mode: string): Promise<void>
  setPlanMode(enabled: boolean): Promise<void>
  createGoal(objective: string, options?: { readonly replace?: boolean }): Promise<GoalSnapshotData>
  getGoal(): Promise<{ readonly goal: GoalSnapshotData | null }>
  updateGoalStatus(status: string): Promise<GoalSnapshotData | null>
  cancelGoal(): Promise<GoalSnapshotData | null>
  compact(options?: { readonly instruction?: string }): Promise<void>
  undoHistory(count: number): Promise<void>
  listCronJobs(): Promise<readonly CronJobInfo[]>
  createCronJob(input: { readonly cron: string; readonly prompt: string; readonly recurring?: boolean }): Promise<CronJobInfo>
  deleteCronJob(id: string): Promise<void>
  listBackgroundTasks(options: { readonly activeOnly: boolean }): Promise<readonly BackgroundTaskInfo[]>
  stopBackgroundTask(taskId: string, options?: { readonly reason?: string }): Promise<void>
  getBackgroundTaskOutput(taskId: string): Promise<string>
  listSkills(): Promise<readonly unknown[]>
  activateSkill(name: string, args?: string): Promise<void>
  listMcpServers(): Promise<readonly unknown[]>
  reconnectMcpServer(name: string): Promise<void>
  addMcpServer(name: string, config: unknown): Promise<void>
  stopMcpServer(name: string): Promise<void>
  removeMcpServer(name: string): Promise<void>
  getComputerUseStatus(): Promise<ComputerUseStatus>
  setComputerUseEnabled(enabled: boolean): Promise<ComputerUseStatus>
}

export interface DesktopHarness {
  readonly homeDir: string
  readonly configPath: string
  ensureConfigFile(): Promise<void>
  getConfig(): Promise<LmcodeConfig>
  setConfig(patch: LmcodeConfigPatch): Promise<LmcodeConfig>
  removeProvider(providerId: string): Promise<LmcodeConfig>
  removeModel(modelId: string): Promise<LmcodeConfig>
  createSession(input: {
    readonly workDir: string
    readonly model?: string
    readonly thinking?: string
    readonly permission?: string
  }): Promise<DesktopSession>
  resumeSession(input: { readonly id: string }): Promise<DesktopSession>
  forkSession(input: {
    readonly id: string
    readonly workDir: string
    readonly title?: string
    readonly metadata?: unknown
  }): Promise<DesktopSession>
  deleteSession(id: string): Promise<void>
  closeSession(id: string): Promise<void>
  listSessions(): Promise<readonly SessionSummary[]>
  renameSession(input: { readonly id: string; readonly title: string }): Promise<void>
  exportSession(input: { readonly id: string; readonly version: string }): Promise<{ zipPath: string }>
  close(options?: { readonly extractMemories?: boolean }): Promise<void>
  memoryStore(): DesktopMemoryStore
}

export interface DesktopMemoryStore {
  list(query?: { readonly limit?: number; readonly search?: string }): Promise<{
    readonly memos: readonly MemoryMemoSummary[]
    readonly total: number
  }>
  delete(id: string): Promise<void>
  close(): Promise<void>
}

export interface DesktopWorktreeMeta {
  readonly branch: string
  readonly path: string
  readonly sourceSessionId: string
}

export interface ThreadView {
  readonly id: string
  readonly cwd: string
  readonly model?: string
  readonly title?: string | null
  readonly thinking?: string
  readonly permission?: string
  readonly planMode?: boolean
  readonly forkedFrom?: string | null
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly sessionDir?: string
  readonly desktopWorktree?: DesktopWorktreeMeta | null
  readonly messages?: unknown[]
}

export interface CoreHost {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>
  ensureThread(session: ThreadBinding): Promise<void>
  reloadThread(session: ThreadBinding): Promise<void>
  /** Load a session from disk without making it the active thread. */
  readThread(session: ThreadBinding): Promise<void>
  /** Reserve this session's turn. Throws when that session already has one. */
  beginTurn(sessionId: string): void
  /**
   * Reserve this session's turn. The same session throws while it already
   * owns a turn. A different session starts immediately.
   */
  acquireTurn(sessionId: string): Promise<void>
  /** Drop this session's reservation when its turn failed to start. */
  releaseTurn(sessionId: string): void
  noteTurnRunning(sessionId: string, running: boolean): void
}

export interface ThreadBinding {
  readonly id: string
  readonly workDir: string
  applyThread(thread: ThreadView): void
}
