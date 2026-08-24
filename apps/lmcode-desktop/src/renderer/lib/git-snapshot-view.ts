import type { GitRepositorySnapshot } from '../../shared/git-types'

export type GitSnapshotView =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-repo' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'clean' }
  | { readonly kind: 'ready' }

const NOT_A_REPO = '当前项目不是 Git 仓库'

/** Prefer a real Git error (missing binary, status failure) over “not a repo”. */
export function gitSnapshotView(snapshot: GitRepositorySnapshot | null): GitSnapshotView {
  if (snapshot === null) return { kind: 'unavailable' }
  const error = snapshot.error?.trim()
  if (error !== undefined && error.length > 0 && error !== NOT_A_REPO) {
    return { kind: 'error', message: error }
  }
  if (!snapshot.isRepository) return { kind: 'not-repo' }
  if (snapshot.changes.length === 0) return { kind: 'clean' }
  return { kind: 'ready' }
}
