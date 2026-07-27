export type GitChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'
  | 'unknown'

export interface GitFileChange {
  readonly path: string
  readonly originalPath?: string
  readonly kind: GitChangeKind
  readonly staged: boolean
  readonly unstaged: boolean
}

export interface GitRepositorySnapshot {
  readonly workDir: string
  readonly isRepository: boolean
  readonly root?: string
  readonly branch?: string
  readonly detached: boolean
  readonly ahead: number
  readonly behind: number
  readonly changes: readonly GitFileChange[]
  readonly error?: string
}

export type GitDiffSectionKind = 'staged' | 'unstaged' | 'untracked'

export interface GitDiffSection {
  readonly kind: GitDiffSectionKind
  readonly patch: string
  readonly truncated: boolean
}

export interface GitFileDiff {
  readonly path: string
  readonly sections: readonly GitDiffSection[]
}

export interface GitCommitResult {
  readonly oid: string
  readonly summary: string
}

export type GitHunkSectionKind = 'staged' | 'unstaged'
export type GitHunkAction = 'stage' | 'unstage' | 'revert'

export interface GitHunkActionInput {
  readonly filePath: string
  readonly sectionKind: GitHunkSectionKind
  readonly hunkIndex: number
  readonly action: GitHunkAction
}

export type GitDiscardScope = 'unstaged' | 'all'
