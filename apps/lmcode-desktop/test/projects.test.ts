import { describe, expect, it } from 'vitest'
import {
  collectProjects,
  groupSessionsByProject,
  latestSessionInProject,
  truncateProjectPath,
} from '../src/renderer/lib/projects'
import type { SessionInfo } from '../src/renderer/types'

function session(id: string, workDir: string, updatedAt: number): SessionInfo {
  return {
    id,
    workDir,
    createdAt: updatedAt,
    updatedAt,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 128000,
    isStreaming: false,
  }
}

describe('truncateProjectPath', () => {
  it('keeps short paths untouched', () => {
    expect(truncateProjectPath('C:\\repo')).toBe('C:\\repo')
  })

  it('truncates the head and preserves the trailing directory names', () => {
    const workDir = 'E:\\project for cc\\lmcode\\apps\\lmcode-desktop'
    const display = truncateProjectPath(workDir)
    expect(display.startsWith('…\\')).toBe(true)
    expect(display.endsWith('lmcode-desktop')).toBe(true)
    expect(display.length).toBeLessThanOrEqual(30)
  })

  it('uses forward slashes when the path uses them', () => {
    const display = truncateProjectPath('/home/user/workspace/some-project', 20)
    expect(display.startsWith('…/')).toBe(true)
    expect(display.endsWith('some-project')).toBe(true)
  })

  it('still surfaces the basename when it alone exceeds the limit', () => {
    const display = truncateProjectPath('C:\\a-very-long-directory-name-beyond-limit', 16)
    expect(display.startsWith('…')).toBe(true)
    expect(display.length).toBeLessThanOrEqual(16)
    expect(display).toContain('a-very-long')
  })
})

describe('collectProjects', () => {
  it('deduplicates working directories and orders by latest activity', () => {
    const projects = collectProjects([
      session('s1', 'C:/repo-a', 10),
      session('s2', 'C:/repo-b', 30),
      session('s3', 'C:/repo-a', 20),
    ])

    expect(projects).toEqual([
      { workDir: 'C:/repo-b', sessionCount: 1, latestActivity: 30 },
      { workDir: 'C:/repo-a', sessionCount: 2, latestActivity: 20 },
    ])
  })

  it('skips sessions without a usable working directory', () => {
    expect(collectProjects([session('s1', '   ', 10)])).toEqual([])
  })

  it('excludes the no-project sentinel directory from the project list', () => {
    const projects = collectProjects(
      [session('s1', 'C:/repo-a', 10), session('s2', 'C:/data/no-project-workspace', 20)],
      'C:/data/no-project-workspace',
    )

    expect(projects).toEqual([
      { workDir: 'C:/repo-a', sessionCount: 1, latestActivity: 10 },
    ])
  })
})

describe('groupSessionsByProject', () => {
  it('groups sessions by working directory with the active project first', () => {
    const groups = groupSessionsByProject(
      [
        session('s1', 'C:/repo-a', 10),
        session('s2', 'C:/repo-b', 30),
        session('s3', 'C:/repo-a', 20),
      ],
      'C:/repo-a',
    )

    expect(groups.map((group) => group.workDir)).toEqual(['C:/repo-a', 'C:/repo-b'])
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['s3', 's1'])
    expect(groups[0]?.latestActivity).toBe(20)
  })

  it('falls back to activity ordering without an active project', () => {
    const groups = groupSessionsByProject([
      session('s1', 'C:/repo-a', 10),
      session('s2', 'C:/repo-b', 30),
    ])
    expect(groups.map((group) => group.workDir)).toEqual(['C:/repo-b', 'C:/repo-a'])
  })

  it('buckets sentinel-directory sessions into the unassociated group', () => {
    const groups = groupSessionsByProject(
      [
        session('s1', 'C:/repo-a', 10),
        session('s2', 'C:/data/no-project-workspace', 30),
      ],
      'C:/data/no-project-workspace',
      'C:/data/no-project-workspace',
    )

    expect(groups.map((group) => group.workDir)).toEqual(['', 'C:/repo-a'])
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['s2'])
  })
})

describe('latestSessionInProject', () => {
  const pool = [
    session('s1', 'C:/repo-a', 10),
    session('s2', 'C:/repo-a', 30),
    session('s3', 'C:/repo-b', 20),
  ]

  it('returns the most recently active session of the target project', () => {
    expect(latestSessionInProject(pool, 'C:/repo-a')?.id).toBe('s2')
    expect(latestSessionInProject(pool, 'C:/repo-b')?.id).toBe('s3')
  })

  it('returns null when the project has no sessions', () => {
    expect(latestSessionInProject(pool, 'C:/repo-c')).toBeNull()
  })

  it('tolerates whitespace padding and empty input', () => {
    expect(latestSessionInProject(pool, '  C:/repo-a  ')?.id).toBe('s2')
    expect(latestSessionInProject(pool, '   ')).toBeNull()
  })
})
