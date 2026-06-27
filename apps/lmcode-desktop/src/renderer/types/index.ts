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

export type AgentEvent = any
