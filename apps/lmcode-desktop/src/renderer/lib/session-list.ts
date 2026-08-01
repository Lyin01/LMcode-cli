import type { SessionInfo } from '@/types'

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll('\\', '/')
    .replace(/\s+/g, ' ')
}

export function sessionDisplayTitle(session: SessionInfo): string {
  return session.title?.trim() || '新任务'
}

/**
 * Search the fields users can see in the sidebar. Every whitespace-separated
 * term must match, so queries such as "desktop release" stay useful even when
 * the words occur in different parts of a title or project path.
 */
export function filterAndSortSessions(
  sessions: readonly SessionInfo[],
  query: string,
): readonly SessionInfo[] {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean)
  const sorted = [...sessions].sort((left, right) => {
    const activityDifference =
      (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt)
    if (activityDifference !== 0) return activityDifference
    return left.id.localeCompare(right.id)
  })

  if (terms.length === 0) return sorted
  return sorted.filter((session) => {
    const searchable = normalizeSearchText(
      `${sessionDisplayTitle(session)}\n${session.workDir ?? ''}`,
    )
    return terms.every((term) => searchable.includes(term))
  })
}

/** Compact, stable activity labels sized for a dense desktop task list. */
export function formatSessionActivity(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''

  const elapsedMs = Math.max(0, now - timestamp)
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时`
  if (elapsedHours < 48) return '昨天'

  const date = new Date(timestamp)
  const current = new Date(now)
  if (date.getFullYear() === current.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}
