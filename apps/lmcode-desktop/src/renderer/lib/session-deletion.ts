export const SESSION_DELETE_CONFIRMATION_MS = 3_000

export interface PendingSessionDeletion {
  readonly sessionId: string
  readonly expiresAt: number
}

export interface SessionDeletionDecision {
  readonly confirmed: boolean
  readonly pending: PendingSessionDeletion | null
}

export function requestSessionDeletion(
  pending: PendingSessionDeletion | null,
  sessionId: string,
  now: number,
): SessionDeletionDecision {
  if (
    pending !== null &&
    pending.sessionId === sessionId &&
    now < pending.expiresAt
  ) {
    return { confirmed: true, pending: null }
  }

  return {
    confirmed: false,
    pending: {
      sessionId,
      expiresAt: now + SESSION_DELETE_CONFIRMATION_MS,
    },
  }
}
