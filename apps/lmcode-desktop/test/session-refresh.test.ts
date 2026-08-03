import { describe, expect, it } from 'vitest'
import { mergeRefreshedSessions } from '../src/renderer/stores/session-store'
import type { SessionInfo } from '../src/renderer/types'

const summaries: readonly SessionSummary[] = [
  {
    id: 'session-a',
    title: 'Refreshed A',
    workDir: 'C:/repo-a',
    sessionDir: 'C:/repo-a/.lmcode',
    createdAt: 1,
    updatedAt: 50,
  },
  {
    id: 'session-b',
    title: 'Brand new B',
    workDir: 'C:/repo-b',
    sessionDir: 'C:/repo-b/.lmcode',
    createdAt: 2,
    updatedAt: 60,
  },
]

describe('desktop session list refresh merge', () => {
  it('preserves runtime metadata of sessions that survived the refresh', () => {
    const existing: SessionInfo[] = [
      {
        id: 'session-a',
        title: 'Stale A',
        workDir: 'C:/repo-a',
        createdAt: 1,
        updatedAt: 40,
        model: 'gpt-5-codex',
        thinkingLevel: 'high',
        permission: 'yolo',
        contextTokens: 1_234,
        maxContextTokens: 200_000,
        isStreaming: true,
      },
    ]

    const mapped = mergeRefreshedSessions(summaries, existing, 'low')

    expect(mapped).toHaveLength(2)
    // Disk fields come from the refresh; runtime fields survive it.
    expect(mapped[0]).toMatchObject({
      id: 'session-a',
      title: 'Refreshed A',
      updatedAt: 50,
      model: 'gpt-5-codex',
      thinkingLevel: 'high',
      permission: 'yolo',
      contextTokens: 1_234,
      maxContextTokens: 200_000,
      isStreaming: true,
    })
    // Sessions unknown to the store fall back to defaults.
    expect(mapped[1]).toMatchObject({
      id: 'session-b',
      title: 'Brand new B',
      thinkingLevel: 'low',
      permission: 'manual',
      contextTokens: 0,
      maxContextTokens: 128_000,
      isStreaming: false,
    })
    expect(mapped[1]?.model).toBeUndefined()
  })
})
