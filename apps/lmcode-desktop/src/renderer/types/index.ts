import type { Event, PermissionMode } from '@lmcode-cli/lmcode-sdk'
import type { ThinkingEffort } from '@/lib/thinking'

export type {
  ApprovalRequestPayload,
  ApprovalResponsePayload,
  InteractionSettledPayload,
  PendingInteraction,
  QuestionRequestPayload,
  QuestionResponsePayload,
  SessionEventPayload,
} from '../../shared/ipc-types'

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
  attachments?: readonly UserAttachment[]
}

export interface UserAttachment {
  readonly id: string
  readonly kind: 'text' | 'image'
  readonly name: string
  readonly filePath?: string
  readonly sizeBytes?: number
  readonly truncated?: boolean
  readonly previewUrl?: string
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
  thinkingLevel: ThinkingEffort
  permission: PermissionMode
  contextTokens: number
  maxContextTokens: number
  isStreaming: boolean
}

export interface QueuedUserMessage {
  readonly id: string
  readonly text: string
  readonly createdAt: number
  readonly attachments: readonly UserAttachment[]
}

export type AgentEvent = Event
