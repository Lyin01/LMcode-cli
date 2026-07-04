export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  thinking?: string
  thinkingState?: 'streaming' | 'complete' | 'hidden'
  toolCalls?: ToolCallInfo[]
  /** Visual flavor for system notices: an error (red) or a neutral notice. */
  variant?: 'error' | 'notice'
}

export interface ToolCallInfo {
  id: string
  toolName: string
  args: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
  progress?: string
}

export interface SessionInfo {
  id: string
  title?: string
  workDir: string
  createdAt: number
  updatedAt: number
  model?: string
  thinkingLevel: string
  permission: string
  contextTokens: number
  maxContextTokens: number
  isStreaming: boolean
}

export type AgentEvent = Event

export interface SessionEventPayload {
  readonly sessionId: string
  readonly event: Event
}

export interface ApprovalRequestPayload extends ApprovalRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly request: ApprovalRequest
}

export interface QuestionRequestPayload {
  readonly sessionId: string
  readonly requestId: string
  readonly questionId: string
  readonly question: string
  readonly options: QuestionRequest['questions'][number]['options']
  readonly request: QuestionRequest
}

export interface ApprovalResponsePayload {
  readonly requestId: string
  readonly response: ApprovalResponse
}

export interface QuestionResponsePayload {
  readonly requestId: string
  readonly answers: QuestionResult
}
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
} from '@lmcode-cli/lmcode-sdk'
