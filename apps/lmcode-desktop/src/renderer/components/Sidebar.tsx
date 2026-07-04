import { useState, useRef, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Trash2,
  Download,
  Check,
  X,
  BookOpen,
  Blocks,
} from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useSession } from '@/hooks/useSession'
import type { SessionInfo } from '@/types'

interface SidebarProps {
  open: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onOpenMemory: () => void
  onOpenExtensions: () => void
}

export function Sidebar({ open, onToggle, onOpenSettings, onOpenMemory, onOpenExtensions }: SidebarProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const setSessions = useSessionStore((s) => s.setSessions)
  const bg = useSessionStore((s) => s.bg)
  const activeStreaming = useSessionStore((s) => s.isStreaming)
  const { createSession } = useSession()

  const isStreamingSession = useCallback(
    (id: string) => (id === currentSessionId ? activeStreaming : !!bg[id]?.isStreaming),
    [currentSessionId, activeStreaming, bg],
  )

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (!q) return list
    return list.filter((s) =>
      (s.title || s.workDir || '新会话').toLowerCase().includes(q),
    )
  }, [sessions, query])

  const refreshSessions = useCallback(async () => {
    const raw = await window.lmcodeAPI.listSessions()
    const mapped: SessionInfo[] = raw.map((s) => ({
      id: s.id,
      title: s.title,
      workDir: s.workDir,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      thinkingLevel: 'auto',
      permission: 'manual',
      contextTokens: 0,
      maxContextTokens: 128000,
      isStreaming: false,
    }))
    useSessionStore.getState().setSessions(mapped)
    return mapped
  }, [])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      await window.lmcodeAPI.deleteSession(id)
      const mapped = await refreshSessions()
      if (id === currentSessionId && mapped.length > 0) {
        selectSession(mapped[0]!.id)
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      const zipPath = await window.lmcodeAPI.exportSession(id)
      if (zipPath) console.log('Session exported to:', zipPath)
    } catch (err) {
      console.error('Failed to export session:', err)
    }
  }

  const startRename = useCallback((e: React.MouseEvent, session: { id: string; title?: string }) => {
    e.stopPropagation()
    setEditingId(session.id)
    setEditValue(session.title || '')
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const confirmRename = useCallback(async () => {
    const id = editingId
    if (!id) return
    const title = editValue.trim()
    if (!title) {
      setEditingId(null)
      return
    }
    try {
      await window.lmcodeAPI.renameSession(id, title)
      setSessions(
        useSessionStore.getState().sessions.map((s) =>
          s.id === id ? { ...s, title } : s,
        ),
      )
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
    setEditingId(null)
  }, [editingId, editValue, setSessions])

  const cancelRename = useCallback(() => setEditingId(null), [])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        confirmRename()
      } else if (e.key === 'Escape') {
        cancelRename()
      }
    },
    [confirmRename, cancelRename],
  )

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden bg-[var(--lm-bg-sidebar)] transition-[width] duration-200 ease-out',
        open ? 'w-[264px]' : 'w-0',
      )}
    >
      <div className="flex h-full w-[264px] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 pb-2 pt-3.5">
          <div className="flex items-center gap-2 pl-1">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--lm-accent)] text-[12px] font-bold text-[var(--lm-accent-fg)]">
              L
            </div>
            <span className="text-[15px] font-semibold tracking-tight">LMCODE</span>
          </div>
          <button
            onClick={onToggle}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="收起侧栏"
          >
            <PanelLeftClose size={17} />
          </button>
        </div>

        {/* New chat */}
        <div className="px-3 pb-2 pt-1">
          <button
            onClick={createSession}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--lm-accent)] px-3 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] shadow-[var(--lm-shadow-soft)] transition-colors hover:bg-[var(--lm-accent-hover)]"
          >
            <Plus size={16} />
            <span>新建对话</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--lm-text-muted)]"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话"
              className="w-full rounded-lg border border-transparent bg-[var(--lm-bg-hover)] py-1.5 pl-8 pr-2.5 text-[13px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none transition-colors focus:border-[var(--lm-border-strong)] focus:bg-[var(--lm-bg-surface)]"
            />
          </div>
        </div>

        {/* Session list */}
        <nav className="flex-1 overflow-y-auto px-2 py-1">
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">
            最近
          </div>
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--lm-text-muted)]">
              {query.trim() ? '未找到匹配的对话' : '暂无对话'}
            </p>
          )}
          {filtered.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                session.id === currentSessionId
                  ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                  : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
              )}
              onClick={() => {
                if (editingId !== session.id) selectSession(session.id)
              }}
              onDoubleClick={(e) => {
                if (editingId !== session.id) startRename(e, session)
              }}
            >
              {editingId === session.id ? (
                <div className="flex flex-1 items-center gap-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={confirmRename}
                    className="min-w-0 flex-1 rounded border border-[var(--lm-accent)] bg-[var(--lm-bg-surface)] px-1.5 py-0.5 text-[12px] text-[var(--lm-text-primary)] outline-none"
                    placeholder="对话名称"
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); confirmRename() }}
                    className="shrink-0 rounded p-0.5 text-[var(--lm-accent-text)]"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelRename() }}
                    className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)]"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <>
                  {isStreamingSession(session.id) && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--lm-accent)]"
                      title="正在生成…"
                    />
                  )}
                  <span className="flex-1 truncate">
                    {session.title || session.workDir || '新会话'}
                  </span>
                  <button
                    onClick={(e) => handleExport(e, session.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] opacity-0 transition-opacity hover:text-[var(--lm-accent-text)] group-hover:opacity-100"
                    title="导出会话"
                  >
                    <Download size={13} />
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] opacity-0 transition-opacity hover:text-[var(--lm-error)] group-hover:opacity-100"
                    title="删除会话"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-[var(--lm-border)] p-2">
          <button
            onClick={onOpenExtensions}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <Blocks size={15} />
            <span>扩展（技能 / MCP）</span>
          </button>
          <button
            onClick={onOpenMemory}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <BookOpen size={15} />
            <span>记忆库</span>
          </button>
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <Settings size={15} />
            <span>设置</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
