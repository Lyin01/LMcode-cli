import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
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
 * Options for `lmcode:createSession`. `noProject` and `workDir` are mutually
 * exclusive: a no-project session never carries a renderer-supplied path —
 * the main process resolves its own sentinel workspace directory instead.
 */
export interface DesktopCreateSessionOptions {
  readonly workDir?: string
  readonly noProject?: boolean
  readonly model?: string
  readonly thinking?: string
  readonly permission?: 'yolo' | 'manual' | 'auto'
}

export type PendingInteraction =
  | { readonly kind: 'approval'; readonly payload: ApprovalRequestPayload }
  | { readonly kind: 'question'; readonly payload: QuestionRequestPayload }
