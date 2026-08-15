import { randomUUID } from 'node:crypto'
import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@lmcode-cli/lmcode-sdk'
import { PendingInteractionRegistry } from '../ipc/pending-interactions.js'

/**
 * Default outcome when an approval is cancelled by the caller or expires.
 */
export const CANCELLED_APPROVAL: ApprovalResponse = { decision: 'cancelled' }

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

export interface InteractionSettledPayload {
  readonly sessionId: string
  readonly requestId: string
}

/**
 * A consumer of session reverse-RPC requests (approvals / questions).
 *
 * The desktop renderer and every remote client are surfaces. A surface
 * reports whether it actually delivered a request via its boolean return;
 * when no surface delivers (e.g. the window is destroyed and no remote
 * client is connected), the hub settles the request with its default
 * outcome instead of letting it hang.
 */
export interface InteractionSurface {
  readonly name: string
  sendApproval(payload: ApprovalRequestPayload): boolean
  sendQuestion(payload: QuestionRequestPayload): boolean
  notifySettled(payload: InteractionSettledPayload): void
}

export interface InteractionHubOptions {
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Shared hub for session approvals and questions.
 *
 * `session.setApprovalHandler` / `setQuestionHandler` are single-handler
 * slots on the SDK session, so the desktop must install exactly one handler
 * per session and fan the request out to every connected surface (renderer +
 * remote clients). Whichever surface responds first settles the request; the
 * others are notified via `notifySettled`.
 */
export class InteractionHub {
  private readonly pendingApprovals = new PendingInteractionRegistry<ApprovalResponse>()
  private readonly pendingQuestions = new PendingInteractionRegistry<QuestionResult>()
  private readonly surfaces = new Map<string, InteractionSurface>()
  private readonly timeoutMs: number

  constructor(options: InteractionHubOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get pendingApprovalCount(): number {
    return this.pendingApprovals.size
  }

  get pendingQuestionCount(): number {
    return this.pendingQuestions.size
  }

  get surfaceCount(): number {
    return this.surfaces.size
  }

  attachSurface(surface: InteractionSurface): void {
    if (this.surfaces.has(surface.name)) {
      throw new Error(`Interaction surface "${surface.name}" is already attached`)
    }
    this.surfaces.set(surface.name, surface)
  }

  detachSurface(name: string): void {
    this.surfaces.delete(name)
  }

  /**
   * Reverse-RPC handler for one session: broadcast the approval to every
   * surface and resolve when any of them responds (or on cancel/timeout).
   */
  requestApproval(sessionId: string, request: ApprovalRequest): Promise<ApprovalResponse> {
    const requestId = `approval:${sessionId}:${randomUUID()}`
    const promise = this.pendingApprovals.request(requestId, sessionId, {
      timeoutMs: this.timeoutMs,
      timeoutValue: CANCELLED_APPROVAL,
      onSettled: (settledRequestId, settledSessionId) =>
        this.broadcastSettled(settledSessionId, settledRequestId),
    })
    if (!this.broadcastApproval(sessionId, requestId, request)) {
      this.pendingApprovals.settle(requestId, CANCELLED_APPROVAL)
    }
    return promise
  }

  /**
   * Reverse-RPC handler for one session: broadcast the question to every
   * surface and resolve when any of them answers (or on cancel/timeout).
   */
  requestQuestion(sessionId: string, request: QuestionRequest): Promise<QuestionResult> {
    const requestId = `question:${sessionId}:${randomUUID()}`
    const promise = this.pendingQuestions.request(requestId, sessionId, {
      timeoutMs: this.timeoutMs,
      timeoutValue: null,
      onSettled: (settledRequestId, settledSessionId) =>
        this.broadcastSettled(settledSessionId, settledRequestId),
    })
    if (!this.broadcastQuestion(sessionId, requestId, request)) {
      this.pendingQuestions.settle(requestId, null)
    }
    return promise
  }

  respondApproval(requestId: string, response: ApprovalResponse): boolean {
    return this.pendingApprovals.settle(requestId, response)
  }

  respondQuestion(requestId: string, result: QuestionResult): boolean {
    return this.pendingQuestions.settle(requestId, result)
  }

  settleSession(sessionId: string): void {
    this.pendingApprovals.settleSession(sessionId, CANCELLED_APPROVAL)
    this.pendingQuestions.settleSession(sessionId, null)
  }

  settleAll(): void {
    this.pendingApprovals.settleAll(CANCELLED_APPROVAL)
    this.pendingQuestions.settleAll(null)
  }

  private broadcastApproval(
    sessionId: string,
    requestId: string,
    request: ApprovalRequest,
  ): boolean {
    let delivered = false
    for (const surface of this.surfaces.values()) {
      if (surface.sendApproval({ sessionId, requestId, request })) delivered = true
    }
    return delivered
  }

  private broadcastQuestion(
    sessionId: string,
    requestId: string,
    request: QuestionRequest,
  ): boolean {
    let delivered = false
    for (const surface of this.surfaces.values()) {
      if (surface.sendQuestion({ sessionId, requestId, request })) delivered = true
    }
    return delivered
  }

  private broadcastSettled(sessionId: string, requestId: string): void {
    const payload: InteractionSettledPayload = { sessionId, requestId }
    for (const surface of this.surfaces.values()) {
      surface.notifySettled(payload)
    }
  }
}
