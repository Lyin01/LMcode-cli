import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
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
  Folder,
  FolderOpen,
} from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useSession } from '@/hooks/useSession'
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher'
import { ProjectPicker } from '@/components/ProjectPicker'
import type { SessionInfo } from '@/types'
import type { RenameConversationRequest } from '@/lib/menu-command'
import {
  requestSessionDeletion,
  type PendingSessionDeletion,
} from '@/lib/session-deletion'
import {
  groupSessionsByProject,
  isNoProjectWorkDir,
  projectDisplayName,
  truncateProjectPath,
} from '@/lib/projects'

interface SidebarProps {
  open: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onOpenMemory: () => void
  onOpenExtensions: () => void
  searchRequestNonce: number
  renameRequest: RenameConversationRequest | null
}

/**
 * Per-session streaming/unread badges. Subscribes with narrow per-id boolean
 * selectors so a background session's stream deltas (which replace the whole
 * `bg` object on every delta) only re-render the affected badge, not the
 * entire sidebar.
 */
function SessionBadges({ sessionId, isCurrent }: { sessionId: string; isCurrent: boolean }) {
  const isStreaming = useSessionStore((s) =>
    isCurrent ? s.isStreaming : (s.bg[sessionId]?.isStreaming ?? false),
  )
  const hasUnread = useSessionStore((s) => !isCurrent && s.bg[sessionId]?.unread === true)

  if (isStreaming) {
    return (
      <span
        role="status"
        aria-label="正在生成"
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--lm-accent)]"
        title="正在生成…"
      />
    )
  }
  if (hasUnread) {
    return (
      <span
        role="status"
        aria-label="有新结果"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lm-accent)]"
        title="有新结果"
      />
    )
  }
  return null
}

export function Sidebar({
  open,
  onToggle,
  onOpenSettings,
  onOpenMemory,
  onOpenExtensions,
  searchRequestNonce,
  renameRequest,
}: SidebarProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const setSessions = useSessionStore((s) => s.setSessions)
  const removeDeletedSession = useSessionStore((s) => s.removeDeletedSession)
  const addMessageToSession = useSessionStore((s) => s.addMessageToSession)
  const clearCurrentSession = useSessionStore((s) => s.clearCurrentSession)
  const noProjectWorkDir = useSessionStore((s) => s.noProjectWorkDir)
  const { createSession } = useSession()
  const { createSessionInProject } = useProjectSwitcher()
  const rawWorkDir = sessions.find((session) => session.id === currentSessionId)?.workDir
  // No-project sessions have no real project: treat them like "no directory".
  const currentWorkDir = isNoProjectWorkDir(rawWorkDir, noProjectWorkDir)
    ? undefined
    : rawWorkDir

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [query, setQuery] = useState('')
  const [pendingDeletion, setPendingDeletion] = useState<PendingSessionDeletion | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const handledRenameNonceRef = useRef(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (!q) return list
    return list.filter((s) =>
      (s.title || s.workDir || '新会话').toLowerCase().includes(q),
    )
  }, [sessions, query])

  const groupedSessions = useMemo(
    () => groupSessionsByProject(filtered, currentWorkDir, noProjectWorkDir),
    [filtered, currentWorkDir, noProjectWorkDir],
  )

  const refreshSessions = useCallback(async () => {
    const raw = await window.lmcodeAPI.listSessions()
    const thinkingLevel = useSessionStore.getState().thinkingLevel
    const mapped: SessionInfo[] = raw.map((s) => ({
      id: s.id,
      title: s.title,
      workDir: s.workDir,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      thinkingLevel,
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
    const decision = requestSessionDeletion(pendingDeletion, id, Date.now())
    setPendingDeletion(decision.pending)
    if (!decision.confirmed || deletingId !== null) return

    setDeletingId(id)
    try {
      await window.lmcodeAPI.deleteSession(id)
      const mapped = await refreshSessions()
      removeDeletedSession(id, mapped)
    } catch (err) {
      console.error('Failed to delete session:', err)
      addMessageToSession(id, {
        id: `sidebar_delete_error_${globalThis.crypto.randomUUID()}`,
        role: 'system',
        variant: 'error',
        content: `删除会话失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    } finally {
      setDeletingId(null)
    }
  }

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      const zipPath = await window.lmcodeAPI.exportSession(id)
      addMessageToSession(id, {
        id: `sidebar_export_${globalThis.crypto.randomUUID()}`,
        role: 'system',
        variant: 'notice',
        content: `会话已导出到：\n\n\`${zipPath}\``,
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('Failed to export session:', err)
      addMessageToSession(id, {
        id: `sidebar_export_error_${globalThis.crypto.randomUUID()}`,
        role: 'system',
        variant: 'error',
        content: `导出会话失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  }

  const beginRename = useCallback((session: { id: string; title?: string }) => {
    setEditingId(session.id)
    setEditValue(session.title || '')
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [])

  const startRename = useCallback(
    (e: React.MouseEvent, session: { id: string; title?: string }) => {
      e.stopPropagation()
      beginRename(session)
    },
    [beginRename],
  )

  useEffect(() => {
    if (searchRequestNonce === 0) return
    const animationFrame = requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => cancelAnimationFrame(animationFrame)
  }, [searchRequestNonce])

  useEffect(() => {
    if (pendingDeletion === null) return
    const delay = Math.max(0, pendingDeletion.expiresAt - Date.now())
    const timeout = globalThis.setTimeout(() => {
      setPendingDeletion((current) => current === pendingDeletion ? null : current)
    }, delay)
    return () => globalThis.clearTimeout(timeout)
  }, [pendingDeletion])

  useEffect(() => {
    if (
      renameRequest === null ||
      handledRenameNonceRef.current === renameRequest.nonce
    ) return
    const session = sessions.find((item) => item.id === renameRequest.sessionId)
    if (!session) return
    handledRenameNonceRef.current = renameRequest.nonce
    beginRename(session)
  }, [beginRename, renameRequest, sessions])

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
        void confirmRename()
      } else if (e.key === 'Escape') {
        cancelRename()
      }
    },
    [confirmRename, cancelRename],
  )

  return (
    <aside
      aria-label="会话侧栏"
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
            type="button"
            onClick={onToggle}
            aria-label="收起侧栏"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="收起侧栏"
          >
            <PanelLeftClose size={17} />
          </button>
        </div>

        {/* Project selector (shared with the composer chip) */}
        <ProjectPicker display="path" className="px-3 pb-2" />

        {/* New chat → welcome screen (the session is created on first send) */}
        <div className="flex gap-1.5 px-3 pb-2 pt-1">
          <button
            onClick={clearCurrentSession}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--lm-accent)] px-3 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] shadow-[var(--lm-shadow-soft)] transition-colors hover:bg-[var(--lm-accent-hover)]"
          >
            <Plus size={16} />
            <span>新建对话</span>
          </button>
          <button
            onClick={() => void createSession()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="打开其他项目"
            aria-label="打开其他项目"
          >
            <FolderOpen size={16} />
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
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话"
              aria-label="搜索对话"
              className="w-full rounded-lg border border-transparent bg-[var(--lm-bg-hover)] py-1.5 pl-8 pr-2.5 text-[13px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none transition-colors focus:border-[var(--lm-border-strong)] focus:bg-[var(--lm-bg-surface)]"
            />
          </div>
        </div>

        {/* Session list, grouped by project */}
        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--lm-text-muted)]">
              {query.trim() ? '未找到匹配的对话' : '暂无对话'}
            </p>
          )}
          {groupedSessions.map((group) => (
            <div key={group.workDir || '__no_project__'} className="mb-1">
              <div
                className="group/project flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--lm-text-muted)]"
                title={group.workDir || undefined}
              >
                <Folder size={11} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {group.workDir ? truncateProjectPath(group.workDir) : '未关联项目'}
                </span>
                <span className="shrink-0 text-[10px] group-hover/project:hidden group-focus-within/project:hidden">
                  {group.sessions.length}
                </span>
                {group.workDir && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      createSessionInProject(group.workDir)
                    }}
                    className="pointer-events-none shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] opacity-0 transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                    title={`在 ${projectDisplayName(group.workDir)} 中新建对话`}
                    aria-label={`在项目 ${group.workDir} 中新建对话`}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              {group.sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                session.id === currentSessionId
                  ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                  : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
              )}
              title={session.workDir}
            >
              {editingId === session.id ? (
                <div className="flex flex-1 items-center gap-1">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={confirmRename}
                    aria-label="对话名称"
                    className="min-w-0 flex-1 rounded border border-[var(--lm-accent)] bg-[var(--lm-bg-surface)] px-1.5 py-0.5 text-[12px] text-[var(--lm-text-primary)] outline-none"
                    placeholder="对话名称"
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void confirmRename() }}
                    aria-label="保存对话名称"
                    className="shrink-0 rounded p-0.5 text-[var(--lm-accent-text)]"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); cancelRename() }}
                    aria-label="取消重命名"
                    className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)]"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => selectSession(session.id)}
                    onDoubleClick={(e) => startRename(e, session)}
                    aria-current={session.id === currentSessionId ? 'page' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--lm-accent)]"
                  >
                    <SessionBadges sessionId={session.id} isCurrent={session.id === currentSessionId} />
                    <span className="flex-1 truncate">
                      {session.title || session.workDir || '新会话'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleExport(e, session.id)}
                    aria-label={`导出会话：${session.title || session.workDir || '新会话'}`}
                    className="pointer-events-none shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] opacity-0 transition-opacity hover:text-[var(--lm-accent-text)] group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]"
                    title="导出会话"
                  >
                    <Download size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, session.id)}
                    disabled={deletingId !== null}
                    aria-label={
                      deletingId === session.id
                        ? `正在删除会话：${session.title || session.workDir || '新会话'}`
                        : pendingDeletion?.sessionId === session.id
                          ? `确认删除会话：${session.title || session.workDir || '新会话'}`
                          : `删除会话：${session.title || session.workDir || '新会话'}`
                    }
                    className={cn(
                      'shrink-0 rounded p-0.5 transition-opacity focus-visible:outline-2 focus-visible:outline-[var(--lm-error)] disabled:cursor-not-allowed',
                      pendingDeletion?.sessionId === session.id || deletingId === session.id
                        ? 'pointer-events-auto bg-[var(--lm-error)]/10 text-[var(--lm-error)] opacity-100'
                        : 'pointer-events-none text-[var(--lm-text-muted)] opacity-0 hover:text-[var(--lm-error)] group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
                    )}
                    title={
                      deletingId === session.id
                        ? '正在删除会话'
                        : pendingDeletion?.sessionId === session.id
                          ? '再次点击确认删除'
                          : '删除会话'
                    }
                  >
                    {pendingDeletion?.sessionId === session.id || deletingId === session.id ? (
                      <span className="px-0.5 text-[10px] font-medium">
                        {deletingId === session.id ? '删除中' : '确认'}
                      </span>
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                </>
              )}
            </div>
              ))}
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
