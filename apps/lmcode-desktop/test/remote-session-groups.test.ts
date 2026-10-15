import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
import { groupSessions } from '../src/remote-app/views/sessions'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workDir: 'C:/work/app',
    sessionDir: 'C:/sessions',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('groupSessions', () => {
  it('orders groups by latest activity and sessions newest-first inside a group', () => {
    const groups = groupSessions(
      [
        session({ id: 'a', workDir: 'C:/work/alpha', updatedAt: 10 }),
        session({ id: 'b', workDir: 'C:/work/beta', updatedAt: 30 }),
        session({ id: 'c', workDir: 'C:/work/alpha', updatedAt: 20 }),
      ],
      null,
    )
    expect(groups.map((group) => group.label)).toEqual(['beta', 'alpha'])
    expect(groups[1]?.sessions.map((item) => item.id)).toEqual(['c', 'a'])
  })

  it('labels the no-project sentinel, matches Windows path variants and drops archived sessions', () => {
    const groups = groupSessions(
      [
        session({ id: 'n1', workDir: 'C:\\data\\no-project-workspace', updatedAt: 5 }),
        session({ id: 'n2', workDir: 'c:/data/no-project-workspace/', updatedAt: 6 }),
        session({ id: 'x', workDir: 'C:/work/app', updatedAt: 9, archived: true }),
      ],
      'C:/data/no-project-workspace',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('无项目')
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['n2', 'n1'])
  })
})
