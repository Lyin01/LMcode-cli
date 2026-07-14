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

export type PendingInteraction =
  | { readonly kind: 'approval'; readonly payload: ApprovalRequestPayload }
  | { readonly kind: 'question'; readonly payload: QuestionRequestPayload }
