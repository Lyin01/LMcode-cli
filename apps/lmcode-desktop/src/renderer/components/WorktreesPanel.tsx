import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import type { GitWorktreeInfo } from '../../shared/worktree-types'

interface WorktreesPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultBranchName(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `lmcode/task-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function WorktreeCard({
  worktree,
  busy,
  onOpen,
}: {
  readonly worktree: GitWorktreeInfo
  readonly busy: boolean
  readonly onOpen: () => void
}) {
  return (
    <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
      <div className="flex items-start gap-2">
        <GitBranch size={14} className="mt-0.5 shrink-0 text-[var(--lm-accent-text)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-medium text-[var(--lm-text-primary)]">
              {worktree.branch ?? `detached@${worktree.head.slice(0, 8)}`}
            </span>
            {worktree.isMain && (
              <span className="rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[9px] text-[var(--lm-text-muted)]">
                主工作树
              </span>
            )}
            {worktree.isCurrent && (
              <span className="flex items-center gap-0.5 rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[9px] text-[var(--lm-accent-text)]">
                <Check size={9} /> 当前
              </span>
            )}
            {worktree.locked && (
              <span className="rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[9px] text-[var(--lm-text-muted)]">
                已锁定
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--lm-text-muted)]">
            {worktree.path}
          </p>
        </div>
        {!worktree.isCurrent && (
          <button
            onClick={onOpen}
            disabled={busy}
            className="shrink-0 rounded-lg border border-[var(--lm-border-strong)] px-2 py-1 text-[10px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
          >
            接力打开
          </button>
        )}
      </div>
    </div>
  )
}

export function WorktreesPanel({ open, onClose }: WorktreesPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const isStreaming = useSessionStore((state) => state.isStreaming)
  const adoptSession = useSessionStore((state) => state.adoptSession)
  const [worktrees, setWorktrees] = useState<readonly GitWorktreeInfo[]>([])
  const [branchName, setBranchName] = useState(defaultBranchName)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(null)
    try {
      setWorktrees(await window.lmcodeAPI.listGitWorktrees(sessionId))
    } catch (reason) {
      setWorktrees([])
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const createAndHandoff = async (): Promise<void> => {
    if (!sessionId || !branchName.trim() || isStreaming) return
    setCreating(true)
    setError(null)
    try {
      const result = await window.lmcodeAPI.createWorktreeHandoff(sessionId, branchName.trim())
      adoptSession(result.session)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  const openWorktree = async (worktree: GitWorktreeInfo): Promise<void> => {
    if (!sessionId || isStreaming) return
    setOpeningPath(worktree.path)
    setError(null)
    try {
      const result = await window.lmcodeAPI.handoffToWorktree(sessionId, worktree.path)
      adoptSession(result.session)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setOpeningPath(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative z-10 ml-auto flex h-full w-[440px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <header className="flex items-center gap-2 border-b border-[var(--lm-border)] px-4 py-3.5">
          <GitFork size={16} className="text-[var(--lm-accent-text)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-[var(--lm-text-primary)]">Git 工作树</h2>
            <p className="text-[10px] text-[var(--lm-text-muted)]">隔离修改，并保留当前对话上下文继续工作</p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'lm-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="border-b border-[var(--lm-border)] p-3">
          <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
            <label className="text-[11px] font-medium text-[var(--lm-text-secondary)]" htmlFor="worktree-branch">
              新工作树分支
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="worktree-branch"
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createAndHandoff()
                }}
                disabled={creating || isStreaming}
                className="min-w-0 flex-1 rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--lm-text-primary)] focus:border-[var(--lm-accent)] disabled:opacity-50"
                spellCheck={false}
              />
              <button
                onClick={() => void createAndHandoff()}
                disabled={creating || isStreaming || !branchName.trim()}
                className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
              >
                {creating ? <Loader2 size={12} className="lm-spin" /> : <Plus size={12} />}
                创建并接力
              </button>
            </div>
            <p className={cn(
              'mt-2 text-[10px]',
              isStreaming ? 'text-[var(--lm-warning)]' : 'text-[var(--lm-text-muted)]',
            )}>
              {isStreaming
                ? '请等待当前回合结束后再接力会话。'
                : '会复制当前会话历史，在独立分支和目录中无缝继续。'}
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-accent-soft)] px-4 py-2 text-[11px] text-[var(--lm-error)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && worktrees.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--lm-text-muted)]">
              <Loader2 size={14} className="lm-spin" /> 读取工作树…
            </div>
          ) : worktrees.length > 0 ? (
            <div className="space-y-2">
              {worktrees.map((worktree) => (
                <WorktreeCard
                  key={worktree.path}
                  worktree={worktree}
                  busy={openingPath !== null || isStreaming}
                  onOpen={() => void openWorktree(worktree)}
                />
              ))}
            </div>
          ) : !error ? (
            <p className="py-10 text-center text-[12px] text-[var(--lm-text-muted)]">暂无可用工作树</p>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
