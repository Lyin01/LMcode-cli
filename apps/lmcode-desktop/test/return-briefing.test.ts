import { describe, expect, it } from 'vitest'

import {
  briefingSummary,
  buildReturnBriefing,
  RETURN_BRIEFING_LIMIT,
} from '../src/renderer/lib/return-briefing'
import type { SessionInfo } from '../src/renderer/types'

const NOW = 1_700_000_000_000

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    workDir: 'E:/work/app',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 1_200_000,
    isStreaming: false,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 1000,
    ...overrides,
  }
}

describe('return briefing', () => {
  it('stays hidden until a first session exists', () => {
    expect(buildReturnBriefing({ sessions: [], now: NOW })).toBeNull()
  })

  it('lists the most recent sessions first and caps the list', () => {
    const sessions = [
      makeSession({ id: 'old', title: '旧任务', updatedAt: NOW - 86_400_000 }),
      makeSession({ id: 'new', title: '最新任务', updatedAt: NOW - 60_000 }),
      makeSession({ id: 'mid', title: '中间任务', updatedAt: NOW - 3_600_000 }),
      makeSession({ id: 'older', title: '更旧的任务', updatedAt: NOW - 172_800_000 }),
    ]

    const briefing = buildReturnBriefing({ sessions, now: NOW }, 2)
    expect(briefing).not.toBeNull()
    expect(briefing!.total).toBe(4)
    expect(briefing!.entries.map((entry) => entry.id)).toEqual(['new', 'mid'])
    expect(briefing!.entries[0]).toMatchObject({ title: '最新任务', activity: '1 分钟' })
    expect(RETURN_BRIEFING_LIMIT).toBeGreaterThan(0)
  })

  it('counts running and unread sessions across the whole list, not just the shown ones', () => {
    const sessions = [
      makeSession({ id: 'a', updatedAt: NOW - 1_000, isStreaming: true }),
      makeSession({ id: 'b', updatedAt: NOW - 2_000 }),
      makeSession({ id: 'c', updatedAt: NOW - 500_000 }),
      makeSession({ id: 'd', updatedAt: NOW - 800_000 }),
    ]

    const briefing = buildReturnBriefing(
      {
        sessions,
        background: { b: { unread: true }, d: { unread: true } },
        now: NOW,
      },
      2,
    )

    expect(briefing!.running).toBe(1)
    expect(briefing!.unread).toBe(2)
    expect(briefing!.entries.map((entry) => entry.state)).toEqual(['running', 'unread'])
  })

  it('treats a running turn as running even when the slice carries an unread badge', () => {
    const briefing = buildReturnBriefing({
      sessions: [makeSession({ id: 'a', isStreaming: true })],
      background: { a: { unread: true } },
      now: NOW,
    })

    expect(briefing!.entries[0]!.state).toBe('running')
    expect(briefing!.unread).toBe(0)
  })

  it('labels the no-project sentinel and empty workdirs', () => {
    const briefing = buildReturnBriefing({
      sessions: [
        makeSession({ id: 'sentinel', workDir: 'C:/Users/x/.lmcode/no-project-workspace' }),
        makeSession({ id: 'empty', workDir: '   ' }),
        makeSession({ id: 'project', workDir: 'E:/repo/lmcode-desktop-source' }),
      ],
      noProjectWorkDir: 'C:/Users/x/.lmcode/no-project-workspace',
      now: NOW,
    })

    // All three share the same updatedAt, so the stable sort keeps the input
    // order; the labels are what this test pins.
    expect(briefing!.entries.map((entry) => entry.project)).toEqual([
      '不关联项目',
      '未关联项目',
      'lmcode-desktop-source',
    ])
  })

  it('summarizes totals plus anything still pending', () => {
    const sessions = [
      makeSession({ id: 'a', isStreaming: true }),
      makeSession({ id: 'b', updatedAt: NOW - 900_000 }),
      makeSession({ id: 'c', updatedAt: NOW - 900_000 }),
    ]

    const idle = buildReturnBriefing({ sessions: [sessions[1]!], now: NOW })
    expect(briefingSummary(idle!)).toBe('共 1 个会话')

    const pending = buildReturnBriefing(
      { sessions, background: { b: { unread: true } }, now: NOW },
    )
    expect(briefingSummary(pending!)).toBe('共 3 个会话 · 1 个仍在运行 · 1 条未读回复')
  })
})
