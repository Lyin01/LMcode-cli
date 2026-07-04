import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  LmcodeConfig,
  LmcodeConfigPatch,
  QuestionRequest,
  QuestionResult,
} from '@lmcode-cli/lmcode-sdk'

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

interface SessionEventPayload {
  readonly sessionId: string
  readonly event: Event
}

interface ApprovalRequestPayload extends ApprovalRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly request: ApprovalRequest
}

interface QuestionRequestPayload {
  readonly sessionId: string
  readonly requestId: string
  readonly questionId: string
  readonly question: string
  readonly options: QuestionRequest['questions'][number]['options']
  readonly request: QuestionRequest
}

interface ApprovalResponsePayload {
  readonly requestId: string
  readonly response: ApprovalResponse
}

interface QuestionResponsePayload {
  readonly requestId: string
  readonly answers: QuestionResult
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
  createSession: (opts: {
    workDir: string
    model?: string
    thinking?: string
    permission?: 'yolo' | 'manual' | 'auto'
  }) => Promise<SessionSummary | undefined>

  resumeSession: (id: string) => Promise<{
    summary: SessionSummary
    resumeState: ResumedSessionState | undefined
  }>

  deleteSession: (id: string) => Promise<void>

  renameSession: (id: string, title: string) => Promise<void>

  listSessions: () => Promise<readonly SessionSummary[]>

  // Chat
  sendMessage: (sessionId: string, text: string) => Promise<void>

  cancelResponse: (sessionId: string) => Promise<void>

  getSessionHistory: (sessionId: string) => Promise<unknown[]>

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

  setPermission: (sessionId: string, mode: string) => Promise<void>

  closeSession: (sessionId: string) => Promise<void>

  // Config
  getConfig: () => Promise<LmcodeConfig>

  setConfig: (patch: LmcodeConfigPatch) => Promise<LmcodeConfig>

  // File operations
  readFileContent: (filePath: string) => Promise<string>

  // Version
  getVersion: () => Promise<string>

  // Config store access
  getHomeDir: () => Promise<string>

  // Event listeners
  onSessionEvent: (callback: (event: SessionEventPayload) => void) => () => void

  onApprovalRequest: (callback: (data: ApprovalRequestPayload) => void) => () => void

  onQuestionRequest: (callback: (data: QuestionRequestPayload) => void) => () => void

  // Navigation events (from tray menu)
  onNavigate: (callback: (data: { route: string }) => void) => () => void

  // Memory
  listMemories: () => Promise<MemorySummary[]>

  searchMemories: (query: string) => Promise<MemorySummary[]>

  deleteMemory: (id: string) => Promise<void>

  // Background tasks
  stopTask: (taskId: string) => Promise<void>

  getTaskOutput: (taskId: string) => Promise<string>

  // Approval/Question responses
  respondApproval: (payload: ApprovalResponsePayload) => void

  respondQuestion: (payload: QuestionResponsePayload) => void

  // App control
  quit: () => void
}

declare global {
  interface Window {
    lmcodeAPI: LmcodeAPI
  }
}

export {}
