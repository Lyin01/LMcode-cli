import type { SessionInfo } from '@/types'

const DEFAULT_PATH_DISPLAY_LENGTH = 30

/**
 * Truncate a project path for compact UI display. The head is replaced with a
 * leading ellipsis so the directory name (the part a user actually recognizes)
 * always survives; the full path is expected to be shown as a tooltip.
 */
export function truncateProjectPath(
  workDir: string,
  maxLength: number = DEFAULT_PATH_DISPLAY_LENGTH,
): string {
  const normalized = workDir.trim()
  if (normalized.length <= maxLength) return normalized

  const separator = normalized.includes('\\') ? '\\' : '/'
  const segments = normalized.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return `…${normalized.slice(-(maxLength - 1))}`

  let tail = segments[segments.length - 1] ?? ''
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `${segments[index]}${separator}${tail}`
    // +2 accounts for the leading ellipsis and separator that will be added.
    if (candidate.length + 2 > maxLength) break
    tail = candidate
  }
  if (tail.length + 2 > maxLength) {
    tail = tail.slice(0, Math.max(1, maxLength - 2))
  }
  return `…${separator}${tail}`
}

/** The directory name users think of as "the project". */
export function projectDisplayName(workDir: string): string {
  const segments = workDir.trim().split(/[\\/]+/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? workDir
}

export interface ProjectSummary {
  readonly workDir: string
  readonly sessionCount: number
  readonly latestActivity: number
}

/**
 * Derive the known project list from the sessions that live in each working
 * directory. Desktop sessions always have a workDir, so sessions are the
 * source of truth for "recently opened projects".
 */
export function collectProjects(
  sessions: readonly SessionInfo[],
): readonly ProjectSummary[] {
  const byWorkDir = new Map<string, { sessionCount: number; latestActivity: number }>()
  for (const session of sessions) {
    const workDir = session.workDir?.trim()
    if (!workDir) continue
    const activity = session.updatedAt ?? session.createdAt ?? 0
    const existing = byWorkDir.get(workDir)
    if (existing) {
      existing.sessionCount += 1
      existing.latestActivity = Math.max(existing.latestActivity, activity)
    } else {
      byWorkDir.set(workDir, { sessionCount: 1, latestActivity: activity })
    }
  }
  return [...byWorkDir.entries()]
    .map(([workDir, info]) => ({ workDir, ...info }))
    .sort((left, right) => right.latestActivity - left.latestActivity)
}

export interface ProjectGroup {
  readonly workDir: string
  readonly sessions: readonly SessionInfo[]
  readonly latestActivity: number
}

/**
 * Group sessions by their project working directory for the sidebar list.
 * The active project (the one containing the current session) is pinned to
 * the top; the remaining groups follow by most recent activity. Sessions
 * inside each group are ordered by recency.
 */
export function groupSessionsByProject(
  sessions: readonly SessionInfo[],
  activeWorkDir?: string,
): readonly ProjectGroup[] {
  const groups = new Map<string, SessionInfo[]>()
  for (const session of sessions) {
    const workDir = session.workDir?.trim() ?? ''
    const bucket = groups.get(workDir)
    if (bucket) bucket.push(session)
    else groups.set(workDir, [session])
  }

  const summarized: ProjectGroup[] = [...groups.entries()].map(([workDir, bucket]) => ({
    workDir,
    sessions: [...bucket].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    latestActivity: bucket.reduce(
      (latest, session) => Math.max(latest, session.updatedAt ?? session.createdAt ?? 0),
      0,
    ),
  }))

  const normalizedActive = activeWorkDir?.trim()
  return summarized.sort((left, right) => {
    if (normalizedActive) {
      if (left.workDir === normalizedActive && right.workDir !== normalizedActive) return -1
      if (right.workDir === normalizedActive && left.workDir !== normalizedActive) return 1
    }
    return right.latestActivity - left.latestActivity
  })
}
