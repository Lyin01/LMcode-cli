import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  PermissionMode,
} from '@lmcode-cli/lmcode-sdk'

export interface SessionEventPayload {
  readonly sessionId: string
  readonly event: Event
}

export interface ApprovalRequestPayload {
  readonly sessionId: string
  readonly requestId: string
  readonly request: ApprovalRequest
}

export interface QuestionRequestPayload {
  readonly sessionId: string
  readonly requestId: string
  readonly request: QuestionRequest
}

export interface ApprovalResponsePayload {
  readonly requestId: string
  readonly response: ApprovalResponse
}

export interface QuestionResponsePayload {
  readonly requestId: string
  readonly result: QuestionResult
}

export interface InteractionSettledPayload {
  readonly sessionId: string
  readonly requestId: string
}

/**
 * Renderer → main 的系统桌面通知请求。目前只承载后台会话回合完成；
 * main 进程在窗口已聚焦时直接丢弃（用户已经看得到），审批通知仍走
 * main 进程自己的既有路径，不经过这里。
 */
export interface DesktopNotificationPayload {
  readonly kind: 'turn-completed'
  readonly sessionId: string
  readonly title: string
  readonly body?: string
}

/**
 * Options for `lmcode:createSession`. `noProject` and `workDir` are mutually
 * exclusive: a no-project session never carries a renderer-supplied path —
 * the main process resolves its own sentinel workspace directory instead.
 */
export interface DesktopCreateSessionOptions {
  readonly workDir?: string
  readonly noProject?: boolean
  readonly model?: string
  readonly thinking?: string
  readonly permission?: PermissionMode
}

export type PendingInteraction =
  | { readonly kind: 'approval'; readonly payload: ApprovalRequestPayload }
  | { readonly kind: 'question'; readonly payload: QuestionRequestPayload }

/**
 * Outcome of `lmcode:compactSession`. A manual `/compact` only *starts* an
 * asynchronous summarization worker inside the agent, so the main process waits
 * for the session's compaction events and reports what actually happened
 * instead of acknowledging the begin as if it were completion.
 */
export type CompactSessionOutcome =
  | {
      readonly outcome: 'completed'
      readonly compactedCount: number
      readonly tokensBefore: number
      readonly tokensAfter: number
      readonly elapsedMs: number
    }
  | { readonly outcome: 'cancelled'; readonly reason?: string; readonly elapsedMs: number }
  | { readonly outcome: 'failed'; readonly message: string; readonly elapsedMs: number }
  | { readonly outcome: 'pending'; readonly elapsedMs: number }
