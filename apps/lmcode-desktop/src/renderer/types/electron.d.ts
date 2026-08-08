import type {
  BackgroundTaskInfo,
  CronJobInfo,
  GoalSnapshotData,
  LmcodeConfig,
  LmcodeConfigPatch,
  PermissionMode,
  SessionStatus,
} from '@lmcode-cli/lmcode-sdk'
import type {
  ApprovalRequestPayload,
  ApprovalResponsePayload,
  DesktopCreateSessionOptions,
  DesktopNotificationPayload,
  InteractionSettledPayload,
  QuestionRequestPayload,
  QuestionResponsePayload,
  SessionEventPayload,
} from '../../shared/ipc-types'
import type {
  GitCommitResult,
  GitDiscardScope,
  GitFileDiff,
  GitHunkActionInput,
  GitRepositorySnapshot,
} from '../../shared/git-types'
import type { ProjectTerminalInfo, TerminalOutputPayload } from '../../shared/terminal-types'
import type { GitWorktreeInfo } from '../../shared/worktree-types'
import type {
  DesktopPromptRequest,
  FileAttachmentPreview,
  TextAttachment,
} from '../../shared/file-types'
import type {
  DesktopMenuCommandPayload,
  DesktopMenuState,
} from '../../shared/menu-types'
import type { ProviderUsageSnapshot } from '../../shared/provider-usage-types'
import type { RemoteState } from '../../shared/remote-types'

declare global {
interface SessionSummary {
  readonly id: string
  readonly title?: string
  readonly lastPrompt?: string
  readonly workDir: string
  readonly sessionDir: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived?: boolean
  readonly metadata?: Record<string, unknown>
}

interface ResumedSessionState {
  sessionMetadata?: unknown
  agents?: unknown
  warning?: unknown
}

interface MemorySummary {
  readonly id: string
  readonly sourceSessionTitle?: string
  readonly sourceSessionId: string
  readonly userNeed: string
  readonly approach: string
  readonly outcome: string
  readonly whatFailed: string
  readonly whatWorked: string
  readonly extractionSource: string
  readonly recordedAt: number
  readonly projectDir: string
  readonly tags?: string[]
}

interface BackgroundTaskInfo {
  readonly taskId: string
  readonly command: string
  readonly description: string
  readonly status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'killed' | 'lost'
  readonly pid: number
  readonly exitCode: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly approvalReason?: string
  readonly timedOut?: boolean
  readonly stopReason?: string
  readonly timeoutMs?: number
  readonly agentId?: string
  readonly subagentType?: string
  readonly failureReason?: string
}

interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source: 'builtin' | 'user' | 'extra' | 'project'
  readonly type?: string
  readonly disableModelInvocation?: boolean
}

interface McpServerInfo {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth'
  readonly toolCount: number
  readonly error?: string
}

interface LmcodeAPI {
  // Session management
  createSession: (opts: DesktopCreateSessionOptions) => Promise<SessionSummary>

  selectWorkDirectory: (initialDirectory?: string) => Promise<string | undefined>

  getNoProjectWorkDir: () => Promise<string>

  resumeSession: (id: string) => Promise<{
    summary: SessionSummary
    resumeState: ResumedSessionState | undefined
  }>

  deleteSession: (id: string) => Promise<void>

  exportSession: (id: string) => Promise<string>

  saveTextFile: (input: {
    readonly suggestedName: string
    readonly content: string
  }) => Promise<string | null>

  renameSession: (id: string, title: string) => Promise<void>

  listSessions: () => Promise<readonly SessionSummary[]>

  // Chat
  sendMessage: (sessionId: string, request: DesktopPromptRequest) => Promise<void>

  steerMessage: (sessionId: string, request: DesktopPromptRequest) => Promise<void>

  cancelResponse: (sessionId: string) => Promise<void>

  getSessionHistory: (sessionId: string) => Promise<unknown[]>

  getSessionStatus: (sessionId: string) => Promise<SessionStatus>

  // Skills & MCP
  listSkills: (sessionId: string) => Promise<SkillSummary[]>
  activateSkill: (sessionId: string, name: string, args?: string) => Promise<void>
  listMcpServers: (sessionId: string) => Promise<McpServerInfo[]>
  reconnectMcpServer: (sessionId: string, name: string) => Promise<void>
  addMcpServer: (sessionId: string, name: string, config: Record<string, unknown>) => Promise<void>
  stopMcpServer: (sessionId: string, name: string) => Promise<void>
  removeMcpServer: (sessionId: string, name: string) => Promise<void>

  // Session control
  setModel: (sessionId: string, model: string) => Promise<void>

  setThinking: (sessionId: string, level: string) => Promise<void>

  setPermission: (sessionId: string, mode: PermissionMode) => Promise<void>

  createGoal: (
    sessionId: string,
    objective: string,
    replace?: boolean,
  ) => Promise<GoalSnapshotData>

  getGoal: (sessionId: string) => Promise<{ readonly goal: GoalSnapshotData | null }>

  updateGoalStatus: (
    sessionId: string,
    status: 'active' | 'complete' | 'paused' | 'blocked',
  ) => Promise<GoalSnapshotData | null>

  cancelGoal: (sessionId: string) => Promise<GoalSnapshotData | null>

  setPlanMode: (sessionId: string, enabled: boolean) => Promise<void>

  compactSession: (sessionId: string, instruction?: string) => Promise<void>

  undoHistory: (sessionId: string, count?: number) => Promise<void>

  closeSession: (sessionId: string) => Promise<void>

  // Scheduled automations
  listCronJobs: (sessionId: string) => Promise<readonly CronJobInfo[]>

  createCronJob: (
    sessionId: string,
    input: { readonly cron: string; readonly prompt: string; readonly recurring?: boolean | undefined },
  ) => Promise<CronJobInfo>

  deleteCronJob: (sessionId: string, id: string) => Promise<void>

  listBackgroundTasks: (sessionId: string) => Promise<readonly BackgroundTaskInfo[]>

  // Config
  getConfig: () => Promise<LmcodeConfig>

  getProviderUsage: (force?: boolean) => Promise<ProviderUsageSnapshot>

  setConfig: (patch: LmcodeConfigPatch) => Promise<LmcodeConfig>

  removeProvider: (providerId: string) => Promise<LmcodeConfig>

  removeModel: (modelId: string) => Promise<LmcodeConfig>

  // File operations
  getPathForFile: (file: File) => string
  readFileContent: (filePath: string) => Promise<TextAttachment>
  readFileAttachment: (filePath: string) => Promise<FileAttachmentPreview>
  readInlineImageAttachment: (
    name: string,
    dataUrl: string,
  ) => Promise<FileAttachmentPreview>

  // Git review
  getGitSnapshot: (sessionId: string) => Promise<GitRepositorySnapshot>

  getGitFileDiff: (sessionId: string, filePath: string) => Promise<GitFileDiff>

  setGitFileStaged: (sessionId: string, filePath: string, staged: boolean) => Promise<void>

  setAllGitFilesStaged: (sessionId: string, staged: boolean) => Promise<void>

  applyGitHunkAction: (sessionId: string, input: GitHunkActionInput) => Promise<void>

  discardGitFileChanges: (
    sessionId: string,
    filePath: string,
    scope: GitDiscardScope,
  ) => Promise<void>

  discardAllGitChanges: (sessionId: string) => Promise<void>

  commitGitChanges: (sessionId: string, message: string) => Promise<GitCommitResult>

  listGitWorktrees: (sessionId: string) => Promise<readonly GitWorktreeInfo[]>

  createWorktreeHandoff: (
    sessionId: string,
    branchName: string,
  ) => Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }>

  handoffToWorktree: (
    sessionId: string,
    worktreePath: string,
  ) => Promise<{ readonly worktree: GitWorktreeInfo; readonly session: SessionSummary }>

  // Project terminal
  startTerminal: (sessionId: string) => Promise<ProjectTerminalInfo>

  writeTerminal: (sessionId: string, input: string) => Promise<void>

  stopTerminal: (sessionId: string) => Promise<void>

  // Version
  getVersion: () => Promise<string>

  // Config store access
  getHomeDir: () => Promise<string>

  // Event listeners
  onSessionEvent: (callback: (event: SessionEventPayload) => void) => () => void

  onApprovalRequest: (callback: (data: ApprovalRequestPayload) => void) => () => void

  onQuestionRequest: (callback: (data: QuestionRequestPayload) => void) => () => void

  onInteractionSettled: (callback: (data: InteractionSettledPayload) => void) => () => void

  onTerminalOutput: (callback: (data: TerminalOutputPayload) => void) => () => void

  // Native application menu
  onMenuCommand: (callback: (data: DesktopMenuCommandPayload) => void) => () => void

  updateMenuState: (state: DesktopMenuState) => void

  // Desktop notifications (fire-and-forget; main decides whether to show)
  sendDesktopNotification: (payload: DesktopNotificationPayload) => void

  // Memory
  listMemories: () => Promise<MemorySummary[]>

  searchMemories: (query: string) => Promise<MemorySummary[]>

  deleteMemory: (id: string) => Promise<void>

  // Background tasks
  stopTask: (sessionId: string, taskId: string) => Promise<void>

  getTaskOutput: (sessionId: string, taskId: string) => Promise<string>

  // Approval/Question responses
  respondApproval: (payload: ApprovalResponsePayload) => Promise<void>

  respondQuestion: (payload: QuestionResponsePayload) => Promise<void>

  // Remote service
  getRemoteState: () => Promise<RemoteState>

  setRemoteEnabled: (enabled: boolean) => Promise<RemoteState>

  setRemotePort: (port: number) => Promise<RemoteState>

  regenerateRemoteToken: () => Promise<RemoteState>

  onRemoteStateChanged: (callback: (state: RemoteState) => void) => () => void

  // App control
  quit: () => void
}

  interface Window {
    lmcodeAPI: LmcodeAPI
  }
}

export {}
