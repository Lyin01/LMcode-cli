import { comparableWorkDir, projectDisplayName } from '@/lib/projects'
import { formatSessionActivity, sessionDisplayTitle } from '@/lib/session-list'
import type { SessionInfo } from '@/types'

export interface BackgroundSliceLike {
  readonly unread?: boolean | undefined
}

export type BriefingState = 'running' | 'unread' | 'idle'

export interface BriefingEntry {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly activity: string
  readonly state: BriefingState
}

export interface ReturnBriefing {
  readonly total: number
  readonly running: number
  readonly unread: number
  readonly entries: readonly BriefingEntry[]
}

/** How many recent sessions the greeting lists. */
export const RETURN_BRIEFING_LIMIT = 3

/**
 * Summarize what happened while the user was away: which sessions are still
 * running, which carry unread replies, and the most recent few to jump back
 * into. Returns null until at least one session exists, so a first run sees
 * no greeting at all.
 */
export function buildReturnBriefing(
  input: {
    readonly sessions: readonly SessionInfo[]
    readonly background?: Readonly<Record<string, BackgroundSliceLike | undefined>> | undefined
    readonly noProjectWorkDir?: string | null | undefined
    readonly now?: number | undefined
  },
  limit: number = RETURN_BRIEFING_LIMIT,
): ReturnBriefing | null {
  const sessions = input.sessions.filter((session) => session.id.length > 0)
  if (sessions.length === 0) return null

  const now = input.now ?? Date.now()
  const background = input.background ?? {}
  const sorted = [...sessions].sort(
    (left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt),
  )

  let running = 0
  let unread = 0
  const entries: BriefingEntry[] = []
  for (const session of sorted) {
    const state = sessionState(session, background[session.id])
    if (state === 'running') running += 1
    if (state === 'unread') unread += 1
    if (entries.length >= limit) continue
    entries.push({
      id: session.id,
      title: sessionDisplayTitle(session),
      project: projectLabel(session.workDir, input.noProjectWorkDir),
      activity: formatSessionActivity(session.updatedAt || session.createdAt, now),
      state,
    })
  }

  return { total: sessions.length, running, unread, entries }
}

/** One-line status: the totals plus anything still pending. */
export function briefingSummary(briefing: ReturnBriefing): string {
  const parts = [`共 ${briefing.total} 个会话`]
  if (briefing.running > 0) parts.push(`${briefing.running} 个仍在运行`)
  if (briefing.unread > 0) parts.push(`${briefing.unread} 条未读回复`)
  return parts.join(' · ')
}

function sessionState(session: SessionInfo, slice: BackgroundSliceLike | undefined): BriefingState {
  // A running turn outranks an unread badge: the session is busy right now.
  if (session.isStreaming) return 'running'
  return slice?.unread === true ? 'unread' : 'idle'
}

function projectLabel(workDir: string, noProjectWorkDir: string | null | undefined): string {
  const trimmed = typeof workDir === 'string' ? workDir.trim() : ''
  if (trimmed.length === 0) return '未关联项目'
  if (
    noProjectWorkDir !== undefined &&
    noProjectWorkDir !== null &&
    comparableWorkDir(trimmed) === comparableWorkDir(noProjectWorkDir)
  ) {
    return '不关联项目'
  }
  return projectDisplayName(trimmed)
}
