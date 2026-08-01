import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../src/renderer/types'
import {
  filterAndSortSessions,
  formatSessionActivity,
  sessionDisplayTitle,
} from '../src/renderer/lib/session-list'

function session(
  id: string,
  title: string | undefined,
  workDir: string,
  updatedAt: number,
): SessionInfo {
  return {
    id,
    title,
    workDir,
    createdAt: updatedAt,
    updatedAt,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 128_000,
    isStreaming: false,
  }
}

describe('desktop session list', () => {
  const sessions = [
    session('older', 'Release desktop package', 'E:\\lmcode', 10),
    session('newer', 'Review renderer', 'E:\\lmcode\\apps\\lmcode-desktop', 30),
    session('middle', undefined, 'D:\\notes', 20),
  ]

  it('sorts by recent activity and uses a useful untitled fallback', () => {
    expect(filterAndSortSessions(sessions, '').map((item) => item.id)).toEqual([
      'newer',
      'middle',
      'older',
    ])
    expect(sessionDisplayTitle(sessions[2]!)).toBe('新任务')
  })

  it('matches every search term across titles and normalized project paths', () => {
    expect(filterAndSortSessions(sessions, 'renderer desktop').map((item) => item.id)).toEqual([
      'newer',
    ])
    expect(filterAndSortSessions(sessions, 'APPS/lmcode').map((item) => item.id)).toEqual([
      'newer',
    ])
  })

  it('formats compact activity labels at the list boundaries', () => {
    const now = new Date(2026, 7, 1, 12, 0, 0).getTime()
    expect(formatSessionActivity(now - 30_000, now)).toBe('刚刚')
    expect(formatSessionActivity(now - 12 * 60_000, now)).toBe('12 分钟')
    expect(formatSessionActivity(now - 3 * 60 * 60_000, now)).toBe('3 小时')
    expect(formatSessionActivity(now - 25 * 60 * 60_000, now)).toBe('昨天')
    expect(formatSessionActivity(new Date(2026, 6, 20).getTime(), now)).toBe('7/20')
    expect(formatSessionActivity(new Date(2025, 11, 31).getTime(), now)).toBe('2025/12/31')
  })
})
