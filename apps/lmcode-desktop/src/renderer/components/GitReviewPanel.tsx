import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import type {
  GitChangeKind,
  GitDiffSection,
  GitFileChange,
  GitFileDiff,
  GitRepositorySnapshot,
} from '../../shared/git-types'

interface GitReviewPanelProps {
  open: boolean
  onClose: () => void
}

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

const DIFF_SECTION_LABELS: Record<GitDiffSection['kind'], string> = {
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪文件',
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

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-[var(--lm-accent-text)]'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-[var(--lm-success)]'
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-[var(--lm-error)]'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return 'text-[var(--lm-text-muted)]'
  }
  return 'text-[var(--lm-text-secondary)]'
}

function diffLineStyle(line: string): React.CSSProperties | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return { backgroundColor: 'color-mix(in srgb, var(--lm-success) 10%, transparent)' }
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return { backgroundColor: 'color-mix(in srgb, var(--lm-error) 10%, transparent)' }
  }
  return undefined
}

function DiffSectionView({ section }: { readonly section: GitDiffSection }) {
  const lines = section.patch.split('\n')
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-3 py-1.5 text-[11px] font-medium text-[var(--lm-text-secondary)]">
        {DIFF_SECTION_LABELS[section.kind]}
        {section.truncated && (
          <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--lm-accent-text)]">
            预览已截断
          </span>
        )}
      </div>
      <pre className="m-0 min-w-max bg-[var(--lm-bg-code)] py-1 font-mono text-[11px] leading-5">
        {lines.map((line, index) => (
          <code
            key={`${index}:${line.slice(0, 24)}`}
            className={cn('block min-h-5 px-3', diffLineClass(line))}
            style={diffLineStyle(line)}
          >
            {line || ' '}
          </code>
        ))}
      </pre>
    </section>
  )
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
      onClick={onSelect}
      title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
      className={cn(
        'flex w-full items-start gap-2 border-b border-[var(--lm-border)] px-3 py-2.5 text-left transition-colors',
        selected
          ? 'bg-[var(--lm-bg-active)]'
          : 'hover:bg-[var(--lm-bg-hover)]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold',
          change.kind === 'deleted' || change.kind === 'unmerged'
            ? 'bg-[var(--lm-accent-soft)] text-[var(--lm-error)]'
            : 'bg-[var(--lm-bg-hover)] text-[var(--lm-accent-text)]',
        )}
        title={status.label}
      >
        {status.short}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-[var(--lm-text-primary)]">
          {file.name}
        </span>
        {file.directory && (
          <span className="block truncate text-[10px] text-[var(--lm-text-muted)]">
            {file.directory}
          </span>
        )}
      </span>
      <span className="flex shrink-0 gap-1">
        {change.staged && (
          <span
            className="rounded bg-[var(--lm-accent-soft)] px-1 py-0.5 text-[9px] font-medium text-[var(--lm-accent-text)]"
            title="已暂存"
          >
            S
          </span>
        )}
        {change.unstaged && (
          <span
            className="rounded bg-[var(--lm-bg-hover)] px-1 py-0.5 text-[9px] font-medium text-[var(--lm-text-muted)]"
            title="工作区"
          >
            W
          </span>
        )}
      </span>
    </button>
  )
}

export function GitReviewPanel({ open, onClose }: GitReviewPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
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
      setSelectedPath((current) => {
        if (current && next.changes.some((change) => change.path === current)) return current
        return next.changes[0]?.path ?? null
      })
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
  }, [open, selectedPath, sessionId])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const updateSelectedStage = useCallback(async (staged: boolean) => {
    if (!sessionId || !selectedPath) return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      await window.lmcodeAPI.setGitFileStaged(sessionId, selectedPath, staged)
      setNotice(staged ? '已暂存所选文件' : '已取消暂存所选文件')
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [refresh, selectedPath, sessionId])

  const commitStagedChanges = useCallback(async () => {
    const message = commitMessage.trim()
    if (!sessionId || !message) return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.lmcodeAPI.commitGitChanges(sessionId, message)
      setCommitMessage('')
      setNotice(`已提交 ${result.oid}`)
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setMutating(false)
    }
  }, [commitMessage, refresh, sessionId])

  if (!open) return null

  const changeCount = snapshot?.changes.length ?? 0
  const selectedChange = snapshot?.changes.find((change) => change.path === selectedPath)
  const hasStagedChanges = snapshot?.changes.some((change) => change.staged) ?? false

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative z-10 ml-auto flex h-full w-[min(900px,calc(100vw-48px))] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--lm-border)] px-4">
          <GitBranch size={17} className="text-[var(--lm-accent-text)]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--lm-text-primary)]">Git 变更审阅</h2>
              {snapshot?.branch && (
                <span className="max-w-48 truncate rounded-full bg-[var(--lm-bg-hover)] px-2 py-0.5 font-mono text-[10px] text-[var(--lm-text-secondary)]">
                  {snapshot.branch}
                </span>
              )}
              {snapshot && snapshot.isRepository && (
                <span className="text-[10px] text-[var(--lm-text-muted)]">{changeCount} 个变更</span>
              )}
            </div>
            <p className="truncate text-[10px] text-[var(--lm-text-muted)]">
              {snapshot?.root ?? snapshot?.workDir ?? '读取项目状态…'}
            </p>
          </div>
          {snapshot && (snapshot.ahead > 0 || snapshot.behind > 0) && (
            <div className="flex items-center gap-2 text-[10px] text-[var(--lm-text-muted)]">
              {snapshot.ahead > 0 && <span className="flex items-center"><ArrowUp size={11} />{snapshot.ahead}</span>}
              {snapshot.behind > 0 && <span className="flex items-center"><ArrowDown size={11} />{snapshot.behind}</span>}
            </div>
          )}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-50"
            title="刷新 Git 状态"
          >
            <RefreshCw size={15} className={loading ? 'lm-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        {snapshot?.isRepository && snapshot.changes.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-4 py-2">
            {selectedChange?.unstaged && (
              <button
                onClick={() => void updateSelectedStage(true)}
                disabled={mutating}
                className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border-strong)] px-2 py-1.5 text-[10px] font-medium text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
                title="将所选文件的工作区变更加入暂存区"
              >
                <Plus size={11} /> 暂存
              </button>
            )}
            {selectedChange?.staged && (
              <button
                onClick={() => void updateSelectedStage(false)}
                disabled={mutating}
                className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border-strong)] px-2 py-1.5 text-[10px] font-medium text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
                title="将所选文件移出暂存区，不修改工作区内容"
              >
                <Minus size={11} /> 取消暂存
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
              className="min-w-0 flex-1 rounded-md border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 text-[11px] text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)] focus:border-[var(--lm-accent)] disabled:opacity-50"
            />
            <button
              onClick={() => void commitStagedChanges()}
              disabled={!hasStagedChanges || !commitMessage.trim() || mutating}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--lm-accent)] px-2.5 py-1.5 text-[10px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
              title="提交所有已暂存变更"
            >
              {mutating ? <Loader2 size={11} className="lm-spin" /> : <GitCommitHorizontal size={11} />}
              提交
            </button>
          </div>
        )}

        {error && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-accent-soft)] px-4 py-2 text-[11px] text-[var(--lm-error)]">
            <AlertTriangle size={13} />
            <span className="truncate">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-hover)] px-4 py-2 text-[11px] text-[var(--lm-success)]">
            <CheckCircle2 size={13} />
            <span>{notice}</span>
          </div>
        )}

        {loading && !snapshot ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[var(--lm-text-muted)]">
            <Loader2 size={16} className="lm-spin" />
            正在读取 Git 状态…
          </div>
        ) : snapshot && !snapshot.isRepository ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <GitBranch size={28} className="text-[var(--lm-text-muted)]" />
            <div>
              <p className="text-[14px] font-medium text-[var(--lm-text-primary)]">当前项目不是 Git 仓库</p>
              <p className="mt-1 text-[12px] text-[var(--lm-text-muted)]">初始化仓库后刷新，即可在这里审阅代码变更。</p>
            </div>
          </div>
        ) : snapshot && snapshot.changes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <CheckCircle2 size={28} className="text-[var(--lm-success)]" />
            <div>
              <p className="text-[14px] font-medium text-[var(--lm-text-primary)]">工作区干净</p>
              <p className="mt-1 text-[12px] text-[var(--lm-text-muted)]">当前项目没有未提交的文件变更。</p>
            </div>
          </div>
        ) : snapshot ? (
          <div className="flex min-h-0 flex-1">
            <nav className="w-60 shrink-0 overflow-y-auto border-r border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)]">
              {snapshot.changes.map((change) => (
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
                <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--lm-text-muted)]">
                  <Loader2 size={15} className="lm-spin" />
                  正在生成 diff…
                </div>
              ) : diff && diff.sections.length > 0 ? (
                <div className="min-w-max">
                  {diff.sections.map((section) => (
                    <DiffSectionView key={section.kind} section={section} />
                  ))}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-[var(--lm-text-muted)]">
                  <FileCode2 size={22} />
                  该变更没有可显示的文本 diff
                </div>
              )}
            </main>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--lm-text-muted)]">
            无法读取 Git 状态
          </div>
        )}
      </aside>
    </div>
  )
}
