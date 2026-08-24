import { describe, expect, it } from 'vitest'
import { gitSnapshotView } from '../src/renderer/lib/git-snapshot-view'
import type { GitRepositorySnapshot } from '../src/shared/git-types'

function snapshot(overrides: Partial<GitRepositorySnapshot>): GitRepositorySnapshot {
  return {
    workDir: 'C:/repo',
    isRepository: true,
    detached: false,
    ahead: 0,
    behind: 0,
    changes: [],
    ...overrides,
  }
}

describe('gitSnapshotView', () => {
  it('prefers a missing-git error over the not-a-repo empty state', () => {
    expect(
      gitSnapshotView(
        snapshot({ isRepository: false, error: '系统中未找到 Git' }),
      ),
    ).toEqual({ kind: 'error', message: '系统中未找到 Git' })
  })

  it('treats a true non-repository as not-repo', () => {
    expect(
      gitSnapshotView(
        snapshot({ isRepository: false, error: '当前项目不是 Git 仓库' }),
      ),
    ).toEqual({ kind: 'not-repo' })
  })

  it('shows a clean workspace only when git status succeeded', () => {
    expect(gitSnapshotView(snapshot({ isRepository: true }))).toEqual({ kind: 'clean' })
    expect(gitSnapshotView(null)).toEqual({ kind: 'unavailable' })
  })
})
