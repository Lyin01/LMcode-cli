import type { SessionInfo } from '@/types'

export interface ConversationFindRequest {
  readonly action: 'open' | 'next' | 'previous'
  readonly nonce: number
}

export interface CommandPaletteRequest {
  readonly nonce: number
}

export interface ComposerDraftRequest {
  readonly nonce: number
  readonly text: string
  readonly mode: 'append' | 'replace'
}

export interface RenameConversationRequest {
  readonly sessionId: string
  readonly nonce: number
}

export interface AdjacentConversationIds {
  readonly previousId: string | null
  readonly nextId: string | null
}

export function getAdjacentConversationIds(
  sessions: readonly SessionInfo[],
  currentSessionId: string | null,
): AdjacentConversationIds {
  if (currentSessionId === null) return { previousId: null, nextId: null }

  const ordered = [...sessions].sort((left, right) => {
    const updatedDifference = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    return updatedDifference !== 0 ? updatedDifference : left.id.localeCompare(right.id)
  })
  const currentIndex = ordered.findIndex((session) => session.id === currentSessionId)
  if (currentIndex === -1) return { previousId: null, nextId: null }

  return {
    previousId: ordered[currentIndex - 1]?.id ?? null,
    nextId: ordered[currentIndex + 1]?.id ?? null,
  }
}
