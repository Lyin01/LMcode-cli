export interface GitWorktreeInfo {
  readonly path: string
  readonly head: string
  readonly branch?: string
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason?: string
  readonly isMain: boolean
  readonly isCurrent: boolean
}
