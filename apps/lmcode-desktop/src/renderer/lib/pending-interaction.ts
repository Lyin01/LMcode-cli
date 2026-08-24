import type { PendingInteraction } from '../../shared/ipc-types'

/** First approval/question that belongs to the session the user is looking at. */
export function visiblePendingInteraction(
  pending: readonly PendingInteraction[],
  sessionId: string | null,
): PendingInteraction | undefined {
  if (sessionId === null) return undefined
  return pending.find((interaction) => interaction.payload.sessionId === sessionId)
}
