import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MessageSquareText,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import {
  GitDiffView,
  type GitReviewComment,
  type GitReviewCommentInput,
} from '@/components/GitDiffView'
import { formatGitReviewComments } from '@/lib/git-review-comments'
import type {
  GitChangeKind,
  GitDiscardScope,
  GitFileChange,
  GitFileDiff,
  GitHunkActionInput,
  GitRepositorySnapshot,
} from '../../shared/git-types'

interface GitReviewPanelProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onAddCommentsToChat: (prompt: string) => void
}

type ReviewScope = 'unstaged' | 'staged' | 'all'

type PendingDestructiveAction =
  | { readonly kind: 'hunk'; readonly input: GitHunkActionInput }
  | {
      readonly kind: 'file'
      readonly filePath: string
      readonly scope: GitDiscardScope
    }
  | { readonly kind: 'all' }

const CHANGE_LABELS: Record<GitChangeKind, { readonly short: string; readonly label: string }> = {
  added: { short: 'A', label: '新增' },
  copied: { short: 'C', label: '复制' },
  deleted: { short: 'D', label: '删除' },
  modified: { short: 'M', label: '修改' },
  renamed: { short: 'R', label: '重命名' },
  'type-changed': { short: 'T', label: '类型变更' },
  unmerged: { short: 'U', label: '冲突' },
  untracked: { short: '?', label: '未跟踪' },
  unknown: { short: '·', label: '变更' },
}

const SCOPE_LABELS: Record<ReviewScope, string> = {
  unstaged: '未暂存',
  staged: '已暂存',
  all: '所有变更',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function splitFilePath(filePath: string): { readonly name: string; readonly directory: string } {
  const normalized = filePath.replaceAll('\\', '/')
  const separator = normalized.lastIndexOf('/')
  if (separator < 0) return { name: normalized, directory: '' }
  return {
    name: normalized.slice(separator + 1),
    directory: normalized.slice(0, separator),
  }
}

function changeInScope(change: GitFileChange, scope: ReviewScope): boolean {
  if (scope === 'staged') return change.staged
  if (scope === 'unstaged') return change.unstaged
  return true
}

function destructiveCopy(action: PendingDestructiveAction): {
  readonly title: string
  readonly description: string
  readonly confirmation: string
} {
  if (action.kind === 'hunk') {
    return {
      title: '撤销这个代码块？',
      description: `将永久丢弃 ${action.input.filePath} 中这个未暂存代码块的修改。`,
      confirmation: '撤销代码块',
    }
  }
  if (action.kind === 'file') {
    return {
      title: '撤销这个文件的变更？',
      description: action.scope === 'all'
        ? `将永久丢弃 ${action.filePath} 的所有已暂存和未暂存修改。未跟踪文件会移到系统回收站。`
        : `将永久丢弃 ${action.filePath} 的未暂存修改。`,
      confirmation: '撤销文件变更',
    }
  }
  return {
    title: '撤销全部变更？',
    description: '将永久丢弃当前仓库的所有已暂存和未暂存修改。未跟踪文件会移到系统回收站。',
    confirmation: '撤销全部变更',
  }
}

function ChangeRow({
  change,
  selected,
  onSelect,
}: {
  readonly change: GitFileChange
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  const file = splitFilePath(change.path)
  const status = CHANGE_LABELS[change.kind]
  return (
    <button
      type="button"
      onClick={onSelect}
      title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
      className={cn(
        'flex w-full items-start gap-2 border-b border-[var(--lm-border)] px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-[var(--lm-bg-active)]' : 'hover:bg-[var(--lm-bg-hover)]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold',
          change.kind === 'deleted' || change.kind === 'unmerged'
            ? 'bg-[var(--lm-accent-soft)] text-[var(--lm-error)]'
            : 'bg-[var(--lm-bg-hover)] text-[var(--lm-accent-text)]',
        )}
        title={status.label}
      >
        {status.short}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
          {file.name}
        </span>
        {file.directory && (
          <span className="block truncate text-[11px] text-[var(--lm-text-muted)]">
            {file.directory}
          </span>
        )}
      </span>
      <span className="flex shrink-0 gap-1">
        {change.staged && (
          <span
            className="rounded bg-[var(--lm-accent-soft)] px-1 py-0.5 text-[10px] font-medium text-[var(--lm-accent-text)]"
            title="已暂存"
          >
            S
          </span>
        )}
        {change.unstaged && (
          <span
            className="rounded bg-[var(--lm-bg-hover)] px-1 py-0.5 text-[10px] font-medium text-[var(--lm-text-muted)]"
            title="工作区"
          >
            W
          </span>
        )}
      </span>
    </button>
  )
}

export function GitReviewPanel({
  open,
  onClose,
  onAddCommentsToChat,
}: GitReviewPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [scope, setScope] = useState<ReviewScope>('unstaged')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffRevision, setDiffRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [comments, setComments] = useState<GitReviewComment[]>([])
  const [pendingDestructive, setPendingDestructive] =
    useState<PendingDestructiveAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    const sequence = refreshSequence.current + 1
    refreshSequence.current = sequence
    setLoading(true)
    setError(null)
    try {
      const next = await window.lmcodeAPI.getGitSnapshot(sessionId)
      if (refreshSequence.current !== sequence) return
      setSnapshot(next)
    } catch (reason) {
      if (refreshSequence.current !== sequence) return
      setSnapshot(null)
      setSelectedPath(null)
      setError(errorMessage(reason))
    } finally {
      if (refreshSequence.current === sequence) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    setScope('unstaged')
    setComments([])
    setPendingDestructive(null)
  }, [sessionId])

  const scopedChanges = useMemo(
    () => snapshot?.changes.filter((change) => changeInScope(change, scope)) ?? [],
    [scope, snapshot],
  )

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && scopedChanges.some((change) => change.path === current)) return current
      return scopedChanges[0]?.path ?? null
    })
  }, [scopedChanges])

  useEffect(() => {
    if (!open || !sessionId || !selectedPath) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setError(null)
    void window.lmcodeAPI.getGitFileDiff(sessionId, selectedPath)
      .then((next) => {
        if (!cancelled) setDiff(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setDiff(null)
          setError(errorMessage(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [diffRevision, open, selectedPath, sessionId])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (pendingDestructive) setPendingDestructive(null)
      else onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open, pendingDestructive])

  const finishMutation = useCallback(async (message: string) => {
    setNotice(message)
    setDiffRevision((revision) => revision + 1)
    await refresh()
  }, [refresh])

  const updateSelectedStage = useCallback(async (staged: boolean) => {
    if (!sessionId || !selectedPath) return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      await window.lmcodeAPI.setGitFileStaged(sessionId, selectedPath, staged)
      await finishMutation(staged ? '已暂存所选文件' : '已取消暂存所选文件')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [finishMutation, selectedPath, sessionId])

  const updateAllStage = useCallback(async (staged: boolean) => {
    if (!sessionId) return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      await window.lmcodeAPI.setAllGitFilesStaged(sessionId, staged)
      await finishMutation(staged ? '已暂存全部变更' : '已取消暂存全部变更')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [finishMutation, sessionId])

  const applyHunkAction = useCallback(async (input: GitHunkActionInput) => {
    if (!sessionId) return
    if (input.action === 'revert') {
      setPendingDestructive({ kind: 'hunk', input })
      return
    }
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      await window.lmcodeAPI.applyGitHunkAction(sessionId, input)
      await finishMutation(input.action === 'stage' ? '已暂存所选代码块' : '已取消暂存所选代码块')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [finishMutation, sessionId])

  const confirmDestructiveAction = useCallback(async () => {
    if (!sessionId || !pendingDestructive) return
    const action = pendingDestructive
    setPendingDestructive(null)
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      if (action.kind === 'hunk') {
        await window.lmcodeAPI.applyGitHunkAction(sessionId, action.input)
        setComments((current) =>
          current.filter((comment) => comment.filePath !== action.input.filePath))
        await finishMutation('已撤销所选代码块')
      } else if (action.kind === 'file') {
        await window.lmcodeAPI.discardGitFileChanges(
          sessionId,
          action.filePath,
          action.scope,
        )
        setComments((current) =>
          current.filter((comment) => comment.filePath !== action.filePath))
        await finishMutation('已撤销所选文件的变更')
      } else {
        await window.lmcodeAPI.discardAllGitChanges(sessionId)
        setComments([])
        await finishMutation('已撤销全部变更')
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [finishMutation, pendingDestructive, sessionId])

  const commitStagedChanges = useCallback(async () => {
    const message = commitMessage.trim()
    if (!sessionId || !message) return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.lmcodeAPI.commitGitChanges(sessionId, message)
      setCommitMessage('')
      setComments((current) =>
        current.filter((comment) => comment.sectionKind !== 'staged'))
      await finishMutation(`已提交 ${result.oid}`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [commitMessage, finishMutation, sessionId])

  const saveComment = useCallback((input: GitReviewCommentInput) => {
    setComments((current) => {
      const existingIndex = current.findIndex((comment) =>
        comment.filePath === input.filePath &&
        comment.sectionKind === input.sectionKind &&
        comment.line === input.line &&
        comment.side === input.side)
      if (existingIndex < 0) {
        return [...current, { ...input, id: globalThis.crypto.randomUUID() }]
      }
      return current.map((comment, index) =>
        index === existingIndex ? { ...comment, body: input.body } : comment)
    })
  }, [])

  const sendCommentsToChat = useCallback(() => {
    if (comments.length === 0) return
    onAddCommentsToChat(formatGitReviewComments(comments))
    setComments([])
    onClose()
  }, [comments, onAddCommentsToChat, onClose])

  if (!open) return null

  const changeCount = snapshot?.changes.length ?? 0
  const selectedChange = snapshot?.changes.find((change) => change.path === selectedPath)
  const hasStagedChanges = snapshot?.changes.some((change) => change.staged) ?? false
  const hasUnstagedChanges = snapshot?.changes.some((change) => change.unstaged) ?? false
  const scopeCounts: Record<ReviewScope, number> = {
    unstaged: snapshot?.changes.filter((change) => change.unstaged).length ?? 0,
    staged: snapshot?.changes.filter((change) => change.staged).length ?? 0,
    all: changeCount,
  }
  const visibleSections = diff?.sections.filter((section) => {
    if (scope === 'all') return true
    if (scope === 'staged') return section.kind === 'staged'
    return section.kind === 'unstaged' || section.kind === 'untracked'
  }) ?? []
  const discardScope: GitDiscardScope =
    scope === 'unstaged' && selectedChange?.kind !== 'untracked' ? 'unstaged' : 'all'
  const pendingCopy = pendingDestructive ? destructiveCopy(pendingDestructive) : null

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-label="关闭 Git 变更审阅"
      />
      <aside className="relative z-10 ml-auto flex h-full w-[min(1040px,calc(100vw-32px))] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--lm-border)] px-4">
          <GitBranch size={17} className="text-[var(--lm-accent-text)]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-[var(--lm-text-primary)]">代码审查</h2>
              {snapshot?.branch && (
                <span className="max-w-48 truncate rounded-full bg-[var(--lm-bg-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--lm-text-secondary)]">
                  {snapshot.branch}
                </span>
              )}
              {snapshot?.isRepository && (
                <span className="text-[11px] text-[var(--lm-text-muted)]">{changeCount} 个变更</span>
              )}
            </div>
            <p className="truncate text-[11px] text-[var(--lm-text-muted)]">
              {snapshot?.root ?? snapshot?.workDir ?? '读取项目状态…'}
            </p>
          </div>
          {snapshot && (snapshot.ahead > 0 || snapshot.behind > 0) && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--lm-text-muted)]">
              {snapshot.ahead > 0 && <span className="flex items-center"><ArrowUp size={11} />{snapshot.ahead}</span>}
              {snapshot.behind > 0 && <span className="flex items-center"><ArrowDown size={11} />{snapshot.behind}</span>}
            </div>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-50"
            title="刷新 Git 状态"
          >
            <RefreshCw size={15} className={loading ? 'lm-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        {snapshot?.isRepository && snapshot.changes.length > 0 && (
          <>
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)] px-3 py-1.5">
              {(Object.keys(SCOPE_LABELS) as ReviewScope[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setScope(item)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                    scope === item
                      ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                      : 'text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)]',
                  )}
                >
                  {SCOPE_LABELS[item]} {scopeCounts[item]}
                </button>
              ))}
              <button
                type="button"
                onClick={sendCommentsToChat}
                disabled={comments.length === 0}
                className="ml-auto flex items-center gap-1.5 rounded-md bg-[var(--lm-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
                title="把全部行内评论写入对话编辑器"
              >
                <MessageSquareText size={11} />
                添加 {comments.length} 条评论到对话
              </button>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-3 py-2">
              {selectedChange?.unstaged && (
                <button
                  type="button"
                  onClick={() => void updateSelectedStage(true)}
                  disabled={mutating}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border-strong)] px-2 py-1.5 text-[11px] font-medium text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-40"
                  title="暂存所选文件"
                >
                  <Plus size={11} /> 暂存文件
                </button>
              )}
              {selectedChange?.staged && (
                <button
                  type="button"
                  onClick={() => void updateSelectedStage(false)}
                  disabled={mutating}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border-strong)] px-2 py-1.5 text-[11px] font-medium text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-40"
                  title="取消暂存所选文件"
                >
                  <Minus size={11} /> 取消暂存文件
                </button>
              )}
              {hasUnstagedChanges && (
                <button
                  type="button"
                  onClick={() => void updateAllStage(true)}
                  disabled={mutating}
                  className="rounded-md px-2 py-1.5 text-[11px] text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)] disabled:opacity-40"
                >
                  全部暂存
                </button>
              )}
              {hasStagedChanges && (
                <button
                  type="button"
                  onClick={() => void updateAllStage(false)}
                  disabled={mutating}
                  className="rounded-md px-2 py-1.5 text-[11px] text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)] disabled:opacity-40"
                >
                  全部取消暂存
                </button>
              )}
              {selectedChange && (
                <button
                  type="button"
                  onClick={() => setPendingDestructive({
                    kind: 'file',
                    filePath: selectedChange.path,
                    scope: discardScope,
                  })}
                  disabled={mutating}
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-[var(--lm-error)] hover:bg-[var(--lm-accent-soft)] disabled:opacity-40"
                  title="撤销所选文件在当前审查范围内的变更"
                >
                  <Trash2 size={11} /> 撤销文件
                </button>
              )}
              {scope === 'all' && changeCount > 1 && (
                <button
                  type="button"
                  onClick={() => setPendingDestructive({ kind: 'all' })}
                  disabled={mutating}
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-[var(--lm-error)] hover:bg-[var(--lm-accent-soft)] disabled:opacity-40"
                >
                  <Trash2 size={11} /> 撤销全部
                </button>
              )}
              <div className="mx-1 h-5 w-px shrink-0 bg-[var(--lm-border)]" />
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && hasStagedChanges) void commitStagedChanges()
                }}
                maxLength={500}
                placeholder={hasStagedChanges ? '提交说明…' : '先暂存变更后提交'}
                disabled={!hasStagedChanges || mutating}
                className="min-w-32 flex-1 rounded-md border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 text-[12px] text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)] focus:border-[var(--lm-accent)] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void commitStagedChanges()}
                disabled={!hasStagedChanges || !commitMessage.trim() || mutating}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--lm-accent)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
                title="提交所有已暂存变更"
              >
                {mutating ? <Loader2 size={11} className="lm-spin" /> : <GitCommitHorizontal size={11} />}
                提交
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-accent-soft)] px-4 py-2 text-[12px] text-[var(--lm-error)]">
            <AlertTriangle size={13} />
            <span className="truncate">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-hover)] px-4 py-2 text-[12px] text-[var(--lm-success)]">
            <CheckCircle2 size={13} />
            <span>{notice}</span>
          </div>
        )}

        {loading && !snapshot ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[14px] text-[var(--lm-text-muted)]">
            <Loader2 size={16} className="lm-spin" />
            正在读取 Git 状态…
          </div>
        ) : snapshot && !snapshot.isRepository ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <GitBranch size={28} className="text-[var(--lm-text-muted)]" />
            <div>
              <p className="text-[15px] font-medium text-[var(--lm-text-primary)]">当前项目不是 Git 仓库</p>
              <p className="mt-1 text-[13px] text-[var(--lm-text-muted)]">初始化仓库后刷新，即可在这里审阅代码变更。</p>
            </div>
          </div>
        ) : snapshot && snapshot.changes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <CheckCircle2 size={28} className="text-[var(--lm-success)]" />
            <div>
              <p className="text-[15px] font-medium text-[var(--lm-text-primary)]">工作区干净</p>
              <p className="mt-1 text-[13px] text-[var(--lm-text-muted)]">当前项目没有未提交的文件变更。</p>
            </div>
          </div>
        ) : snapshot && scopedChanges.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <FileCode2 size={25} className="text-[var(--lm-text-muted)]" />
            <div>
              <p className="text-[14px] font-medium text-[var(--lm-text-primary)]">没有{SCOPE_LABELS[scope]}文件</p>
              <p className="mt-1 text-[12px] text-[var(--lm-text-muted)]">切换上方范围查看其他变更。</p>
            </div>
          </div>
        ) : snapshot ? (
          <div className="flex min-h-0 flex-1">
            <nav className="w-60 shrink-0 overflow-y-auto border-r border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)]" aria-label="变更文件">
              {scopedChanges.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  selected={selectedPath === change.path}
                  onSelect={() => setSelectedPath(change.path)}
                />
              ))}
            </nav>
            <main className="min-w-0 flex-1 overflow-auto bg-[var(--lm-bg-code)]">
              {diffLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--lm-text-muted)]">
                  <Loader2 size={15} className="lm-spin" />
                  正在生成 diff…
                </div>
              ) : diff && visibleSections.length > 0 ? (
                <div className="min-w-max">
                  {visibleSections.map((section) => (
                    <GitDiffView
                      key={`${diff.path}:${section.kind}:${diffRevision}`}
                      filePath={diff.path}
                      section={section}
                      comments={comments}
                      disabled={mutating}
                      onSaveComment={saveComment}
                      onDeleteComment={(commentId) =>
                        setComments((current) =>
                          current.filter((comment) => comment.id !== commentId))}
                      onHunkAction={(input) => void applyHunkAction(input)}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--lm-text-muted)]">
                  <FileCode2 size={22} />
                  该变更没有可显示的文本 diff
                </div>
              )}
            </main>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--lm-text-muted)]">
            无法读取 Git 状态
          </div>
        )}

        {pendingDestructive && pendingCopy && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-6 backdrop-blur-[1px]">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="git-destructive-title"
              className="w-full max-w-md rounded-xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] p-4 shadow-[var(--lm-shadow-pop)]"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-[var(--lm-accent-soft)] p-2 text-[var(--lm-error)]">
                  <AlertTriangle size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 id="git-destructive-title" className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                    {pendingCopy.title}
                  </h3>
                  <p className="mt-1.5 text-[12px] leading-5 text-[var(--lm-text-secondary)]">
                    {pendingCopy.description}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDestructive(null)}
                  className="rounded-md border border-[var(--lm-border-strong)] px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]"
                  autoFocus
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void confirmDestructiveAction()}
                  className="rounded-md bg-[var(--lm-error)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                >
                  {pendingCopy.confirmation}
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
