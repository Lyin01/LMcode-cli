import { useEffect, useState, useRef, useCallback } from 'react'
import { X, Search, Trash2, BookOpen, Tag, Clock, AlertTriangle } from 'lucide-react'

interface MemoryBrowserProps {
  open: boolean
  onClose: () => void
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

export function MemoryBrowser({ open, onClose }: MemoryBrowserProps) {
  const [memos, setMemos] = useState<MemorySummary[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const fetchMemories = useCallback(async (query?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = query?.trim()
        ? await window.lmcodeAPI.searchMemories(query.trim())
        : await window.lmcodeAPI.listMemories()
      setMemos(result as MemorySummary[])
    } catch (err) {
      console.error('Failed to fetch memories:', err)
      setError('无法加载记忆，请检查是否已安装 @lmcode/memory 包')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchMemories()
      setTimeout(() => searchRef.current?.focus(), 100)
    }
  }, [open, fetchMemories])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => fetchMemories(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery, fetchMemories, open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const handleDelete = async (id: string) => {
    try {
      await window.lmcodeAPI.deleteMemory(id)
      setMemos((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      console.error('Failed to delete memory:', err)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 ml-auto flex h-full w-[420px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-[var(--lm-accent-text)]" />
            <h2 className="text-[15px] font-semibold text-[var(--lm-text-primary)]">记忆库</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-[var(--lm-border)] px-4 py-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--lm-text-muted)]" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索记忆..."
              className="w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] py-2 pl-9 pr-3 text-[14px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none transition-colors focus:border-[var(--lm-accent)]"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-2 text-[var(--lm-text-muted)]">
                <div className="h-5 w-5 rounded-full border-2 border-[var(--lm-border-strong)] border-t-[var(--lm-accent)] lm-spin" />
                <span className="text-[12px]">加载中...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <AlertTriangle size={28} className="text-[var(--lm-warning)]" />
              <p className="text-[14px] text-[var(--lm-text-secondary)]">{error}</p>
            </div>
          )}

          {!loading && !error && memos.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <BookOpen size={28} className="text-[var(--lm-text-muted)]" />
              <p className="text-[14px] text-[var(--lm-text-secondary)]">
                {searchQuery.trim() ? '未找到匹配的记忆' : '暂无记忆'}
              </p>
              <p className="text-[12px] text-[var(--lm-text-muted)]">
                {searchQuery.trim() ? '尝试其他关键词' : '与 AI 交互后，经验将被自动记录为记忆'}
              </p>
            </div>
          )}

          {!loading && !error && memos.length > 0 && (
            <div className="divide-y divide-[var(--lm-border)]">
              {memos.map((memo) => (
                <div
                  key={memo.id}
                  className="group relative px-4 py-3 transition-colors hover:bg-[var(--lm-bg-hover)]"
                >
                  <button
                    onClick={() => handleDelete(memo.id)}
                    className="absolute right-3 top-3 rounded p-1 text-[var(--lm-text-muted)] opacity-0 transition-opacity hover:text-[var(--lm-error)] group-hover:opacity-100"
                    title="删除记忆"
                  >
                    <Trash2 size={13} />
                  </button>

                  <h3 className="pr-6 text-[14px] font-medium text-[var(--lm-text-primary)]">
                    {truncate(memo.userNeed || '(无标题)', 60)}
                  </h3>

                  <p className="mt-1 line-clamp-2 text-[12.5px] text-[var(--lm-text-secondary)]">
                    {truncate(memo.outcome || memo.approach || '', 120)}
                  </p>

                  {memo.tags && memo.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {memo.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-0.5 rounded-full bg-[var(--lm-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--lm-accent-text)]"
                        >
                          <Tag size={8} />
                          {tag}
                        </span>
                      ))}
                      {memo.tags.length > 4 && (
                        <span className="text-[10px] text-[var(--lm-text-muted)]">+{memo.tags.length - 4}</span>
                      )}
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--lm-text-muted)]">
                    <Clock size={10} />
                    <span>{formatTime(memo.recordedAt)}</span>
                    {memo.sourceSessionTitle && (
                      <>
                        <span className="mx-1">·</span>
                        <span className="max-w-[140px] truncate">{memo.sourceSessionTitle}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--lm-border)] px-4 py-2.5">
          <p className="text-[11px] text-[var(--lm-text-muted)]">
            共 {memos.length} 条记忆
            {searchQuery.trim() && ` (搜索: "${searchQuery.trim()}")`}
          </p>
        </div>
      </div>
    </div>
  )
}
