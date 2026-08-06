import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Blocks,
  BookOpen,
  Check,
  ChevronRight,
  Download,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { mergeRefreshedSessions, useSessionStore } from '@/stores/session-store'
import { unreadCountForSession, useInboxStore } from '@/stores/inbox-store'
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher'
import { ProjectPicker } from '@/components/ProjectPicker'
import type { SessionInfo } from '@/types'
import type { RenameConversationRequest } from '@/lib/menu-command'
import {
  requestSessionDeletion,
  type PendingSessionDeletion,
} from '@/lib/session-deletion'
import { groupSessionsByProject, projectDisplayName } from '@/lib/projects'
import {
  filterAndSortSessions,
  formatSessionActivity,
  sessionDisplayTitle,
} from '@/lib/session-list'
import {
  getStoredCollapsedProjects,
  setStoredCollapsedProjects,
} from '@/lib/sidebar-preference'
import {
  getPinnedSessions,
  setSessionPinned,
} from '@/lib/pinned-sessions'
import { historyToMessages } from '@/lib/history'

interface SidebarProps {
  open: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onOpenMemory: () => void
  onOpenExtensions: () => void
  searchRequestNonce: number
  renameRequest: RenameConversationRequest | null
}

interface SessionListItemProps {
  readonly session: SessionInfo
  readonly isCurrent: boolean
  readonly isPinned: boolean
  readonly activityLabel: string
  readonly renameRequestNonce: number | null
  readonly pendingDeletion: PendingSessionDeletion | null
  readonly deletingId: string | null
  readonly onSelect: (id: string) => void
  readonly onRename: (id: string, title: string) => Promise<void>
  readonly onExport: (id: string) => void
  readonly onExportText: (id: string, format: 'markdown' | 'json') => void
  readonly onTogglePin: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onNavigateKey: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void
  readonly registerButton: (id: string, node: HTMLButtonElement | null) => void
}

function SessionStatusIndicator({
  sessionId,
  isCurrent,
}: {
  readonly sessionId: string
  readonly isCurrent: boolean
}) {
  const isStreaming = useSessionStore((state) =>
    isCurrent ? state.isStreaming : (state.bg[sessionId]?.isStreaming ?? false),
  )
  const hasUnread = useSessionStore(
    (state) => !isCurrent && state.bg[sessionId]?.unread === true,
  )
  const inboxUnread = useInboxStore((state) =>
    isCurrent ? 0 : unreadCountForSession(state.items, sessionId),
  )

  if (isStreaming) {
    return (
      <span
        role="status"
        aria-label="正在生成"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--lm-accent-text)]"
        title="正在生成"
      >
        <LoaderCircle size={12} className="lm-spin" />
      </span>
    )
  }
  if (inboxUnread > 0) {
    return (
      <span
        role="status"
        aria-label={`有 ${inboxUnread} 条未读通知`}
        title={`有 ${inboxUnread} 条未读通知`}
        className="flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--lm-accent-soft)] px-0.5 text-[8px] font-semibold text-[var(--lm-accent-text)]">
          {inboxUnread > 9 ? '9+' : inboxUnread}
        </span>
      </span>
    )
  }
  if (hasUnread) {
    return (
      <span
        role="status"
        aria-label="有新结果"
        className="flex h-4 w-4 shrink-0 items-center justify-center"
        title="有新结果"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--lm-accent-text)]" />
      </span>
    )
  }
  return <span aria-hidden="true" className="h-4 w-4 shrink-0" />
}

function CollapsedProjectActivity({
  sessionIds,
  visible,
}: {
  readonly sessionIds: readonly string[]
  readonly visible: boolean
}) {
  const activity = useSessionStore((state) => {
    let hasUnread = false
    let hasCurrent = false
    for (const sessionId of sessionIds) {
      if (sessionId === state.currentSessionId) {
        hasCurrent = true
        if (state.isStreaming) return 3
        continue
      }
      const background = state.bg[sessionId]
      if (background?.isStreaming) return 3
      if (background?.unread) hasUnread = true
    }
    if (hasUnread) return 2
    return hasCurrent ? 1 : 0
  })

  if (!visible || activity === 0) return null
  if (activity === 3) {
    return (
    <LoaderCircle
      size={11}
      aria-label="项目中有任务正在运行"
      className="lm-spin shrink-0 text-[var(--lm-accent-text)]"
    />
    )
  }
  return activity === 2 ? (
    <span
      role="status"
      aria-label="项目中有新结果"
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lm-accent-text)]"
    />
  ) : (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lm-text-muted)]"
      title="当前任务在此项目中"
    />
  )
}

const SessionListItem = memo(function SessionListItem({
  session,
  isCurrent,
  isPinned,
  activityLabel,
  renameRequestNonce,
  pendingDeletion,
  deletingId,
  onSelect,
  onRename,
  onExport,
  onExportText,
  onTogglePin,
  onDelete,
  onNavigateKey,
  registerButton,
}: SessionListItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const handledRenameNonceRef = useRef(0)
  const title = sessionDisplayTitle(session)
  const deletePending = pendingDeletion?.sessionId === session.id
  const isDeleting = deletingId === session.id

  const beginRename = useCallback(() => {
    setEditValue(session.title?.trim() || '')
    setEditing(true)
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [session.title])

  useEffect(() => {
    if (
      renameRequestNonce === null ||
      handledRenameNonceRef.current === renameRequestNonce
    ) return
    handledRenameNonceRef.current = renameRequestNonce
    beginRename()
  }, [beginRename, renameRequestNonce])

  const confirmRename = useCallback(async () => {
    if (!editing) return
    const nextTitle = editValue.trim()
    setEditing(false)
    if (!nextTitle || nextTitle === session.title?.trim()) return
    await onRename(session.id, nextTitle)
  }, [editValue, editing, onRename, session.id, session.title])

  const cancelRename = useCallback(() => {
    setEditing(false)
    setEditValue('')
  }, [])

  return (
    <div
      className={cn(
        'lm-session-row group/session mb-0.5 flex min-h-9 w-full items-center rounded-lg px-1.5 text-left transition-colors',
        isCurrent
          ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)] shadow-[inset_0_0_0_1px_var(--lm-border)]'
          : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
      )}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 py-1">
          <input
            ref={renameInputRef}
            type="text"
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void confirmRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
            onBlur={() => void confirmRename()}
            aria-label="任务名称"
            className="min-w-0 flex-1 rounded-md border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-2 py-1 text-[12px] text-[var(--lm-text-primary)] shadow-sm outline-none focus:border-[var(--lm-accent)]"
            placeholder="任务名称"
          />
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void confirmRename()}
            aria-label="保存任务名称"
            className="rounded-md p-1 text-[var(--lm-accent-text)] hover:bg-[var(--lm-bg-hover)]"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={cancelRename}
            aria-label="取消重命名"
            className="rounded-md p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)]"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <>
          <button
            ref={(node) => registerButton(session.id, node)}
            type="button"
            data-session-id={session.id}
            onClick={() => onSelect(session.id)}
            onDoubleClick={beginRename}
            onKeyDown={(event) => onNavigateKey(event, session.id)}
            aria-current={isCurrent ? 'page' : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--lm-accent)]"
            title={`${title}\n${session.workDir}`}
          >
            <SessionStatusIndicator sessionId={session.id} isCurrent={isCurrent} />
            {isPinned && (
              <Pin size={11} className="shrink-0 text-[var(--lm-accent-text)]" aria-label="已置顶" />
            )}
            <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', isCurrent && 'font-medium')}>
              {title}
            </span>
          </button>

          <span
            className={cn(
              'ml-1 shrink-0 text-[10px] tabular-nums text-[var(--lm-text-muted)] transition-opacity group-hover/session:hidden group-focus-within/session:hidden',
              (menuOpen || deletePending) && 'hidden',
            )}
          >
            {activityLabel}
          </span>

          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={`打开任务操作：${title}`}
                title="任务操作"
                className={cn(
                  'ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--lm-text-muted)] outline-none transition-all hover:bg-[var(--lm-bg-surface)] hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]',
                  menuOpen || deletePending
                    ? 'opacity-100'
                    : 'pointer-events-none opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100',
                  deletePending && 'text-[var(--lm-error)]',
                )}
              >
                <MoreHorizontal size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="right"
                align="start"
                sideOffset={5}
                className="z-50 min-w-44 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-pop)]"
              >
                <DropdownMenu.Item
                  onSelect={beginRename}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]"
                >
                  <Pencil size={14} />
                  重命名
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => onExport(session.id)}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]"
                >
                  <Download size={14} />
                  导出任务
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => onExportText(session.id, 'markdown')}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]"
                >
                  <FileText size={14} />
                  导出为 Markdown
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => onExportText(session.id, 'json')}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]"
                >
                  <FileJson size={14} />
                  导出为 JSON
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => onTogglePin(session.id)}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]"
                >
                  <Pin size={14} className={isPinned ? 'text-[var(--lm-accent-text)]' : undefined} />
                  {isPinned ? '取消置顶' : '置顶任务'}
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--lm-border)]" />
                <DropdownMenu.Item
                  disabled={deletingId !== null}
                  onSelect={(event) => {
                    if (!deletePending) event.preventDefault()
                    onDelete(session.id)
                  }}
                  aria-label={deletePending ? `确认删除任务：${title}` : `删除任务：${title}`}
                  className={cn(
                    'flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-error)] outline-none data-[highlighted]:bg-[var(--lm-error)]/10 data-[disabled]:opacity-40',
                    deletePending && 'bg-[var(--lm-error)]/10 font-medium',
                  )}
                >
                  {isDeleting ? <LoaderCircle size={14} className="lm-spin" /> : <Trash2 size={14} />}
                  {isDeleting ? '正在删除…' : deletePending ? '再次选择以确认删除' : '删除任务'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      )}
    </div>
  )
})

export function Sidebar({
  open,
  onToggle,
  onOpenSettings,
  onOpenMemory,
  onOpenExtensions,
  searchRequestNonce,
  renameRequest,
}: SidebarProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const selectSession = useSessionStore((state) => state.selectSession)
  const setSessions = useSessionStore((state) => state.setSessions)
  const removeDeletedSession = useSessionStore((state) => state.removeDeletedSession)
  const addMessageToSession = useSessionStore((state) => state.addMessageToSession)
  const clearCurrentSession = useSessionStore((state) => state.clearCurrentSession)
  const noProjectWorkDir = useSessionStore((state) => state.noProjectWorkDir)
  // Take the action straight from the store: mounting the whole useSession
  // hook here would add nothing else the sidebar needs.
  const createSession = useSessionStore((state) => state.createSession)
  const { createSessionInProject } = useProjectSwitcher()

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const [pendingDeletion, setPendingDeletion] = useState<PendingSessionDeletion | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() =>
    getStoredCollapsedProjects(),
  )
  const [pinnedSessions, setPinnedSessions] = useState<ReadonlySet<string>>(() =>
    getPinnedSessions(),
  )
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  const filtered = useMemo(
    () => filterAndSortSessions(sessions, deferredQuery, pinnedSessions),
    [deferredQuery, pinnedSessions, sessions],
  )
  // Keep project ordering stable while users move between tasks. Activity —
  // not selection — determines where a project appears in the list.
  const groupedSessions = useMemo(
    () => groupSessionsByProject(filtered, undefined, noProjectWorkDir),
    [filtered, noProjectWorkDir],
  )
  const searching = deferredQuery.trim().length > 0

  const existingGroupKeys = useMemo(
    () =>
      new Set(
        groupSessionsByProject(sessions, undefined, noProjectWorkDir).map(
          (group) => group.workDir || '__no_project__',
        ),
      ),
    [noProjectWorkDir, sessions],
  )

  const visibleSessionIds = useMemo(
    () =>
      groupedSessions.flatMap((group) => {
        const groupKey = group.workDir || '__no_project__'
        if (!searching && collapsedProjects.has(groupKey)) return []
        return group.sessions.map((session) => session.id)
      }),
    [collapsedProjects, groupedSessions, searching],
  )

  useEffect(() => {
    const interval = globalThis.setInterval(() => setActivityNow(Date.now()), 60_000)
    return () => globalThis.clearInterval(interval)
  }, [])

  useEffect(() => {
    setCollapsedProjects((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((key) => existingGroupKeys.has(key)))
      if (next.size === current.size) return current
      setStoredCollapsedProjects(next)
      return next
    })
  }, [existingGroupKeys])

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

  const toggleProjectCollapsed = useCallback((key: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setStoredCollapsedProjects(next)
      return next
    })
  }, [])

  const expandProject = useCallback((key: string) => {
    setCollapsedProjects((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      setStoredCollapsedProjects(next)
      return next
    })
  }, [])

  const registerSessionButton = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) sessionButtonRefs.current.set(id, node)
    else sessionButtonRefs.current.delete(id)
  }, [])

  const focusSession = useCallback((id: string | undefined) => {
    if (!id) return
    sessionButtonRefs.current.get(id)?.focus()
  }, [])

  const handleSessionNavigateKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const currentIndex = visibleSessionIds.indexOf(id)
      if (event.key === 'Home') {
        focusSession(visibleSessionIds[0])
      } else if (event.key === 'End') {
        focusSession(visibleSessionIds.at(-1))
      } else if (event.key === 'ArrowDown') {
        focusSession(visibleSessionIds[Math.min(currentIndex + 1, visibleSessionIds.length - 1)])
      } else {
        focusSession(visibleSessionIds[Math.max(currentIndex - 1, 0)])
      }
    },
    [focusSession, visibleSessionIds],
  )

  const refreshSessions = useCallback(async () => {
    const raw = await window.lmcodeAPI.listSessions()
    const state = useSessionStore.getState()
    // Merge instead of remap: sessions that survived the refresh keep the
    // runtime metadata (model, permission, token counters, streaming flag)
    // the store already accumulated for them.
    const mapped = mergeRefreshedSessions(raw, state.sessions, state.thinkingLevel)
    state.setSessions(mapped)
    return mapped
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      const decision = requestSessionDeletion(pendingDeletion, id, Date.now())
      setPendingDeletion(decision.pending)
      if (!decision.confirmed || deletingId !== null) return

      setDeletingId(id)
      void (async () => {
        try {
          await window.lmcodeAPI.deleteSession(id)
          const mapped = await refreshSessions()
          removeDeletedSession(id, mapped)
        } catch (error) {
          console.error('Failed to delete session:', error)
          addMessageToSession(id, {
            id: `sidebar_delete_error_${globalThis.crypto.randomUUID()}`,
            role: 'system',
            variant: 'error',
            content: `删除任务失败：${error instanceof Error ? error.message : String(error)}`,
            timestamp: Date.now(),
          })
        } finally {
          setDeletingId(null)
        }
      })()
    },
    [addMessageToSession, deletingId, pendingDeletion, refreshSessions, removeDeletedSession],
  )

  const handleExport = useCallback((id: string) => {
    void window.lmcodeAPI.exportSession(id).then(
      (zipPath) => {
        addMessageToSession(id, {
          id: `sidebar_export_${globalThis.crypto.randomUUID()}`,
          role: 'system',
          variant: 'notice',
          content: `任务已导出到：\n\n\`${zipPath}\``,
          timestamp: Date.now(),
        })
      },
      (error: unknown) => {
        console.error('Failed to export session:', error)
        addMessageToSession(id, {
          id: `sidebar_export_error_${globalThis.crypto.randomUUID()}`,
          role: 'system',
          variant: 'error',
          content: `导出任务失败：${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        })
      },
    )
  }, [addMessageToSession])

  const handleExportText = useCallback(
    async (id: string, format: 'markdown' | 'json') => {
      try {
        const history = await window.lmcodeAPI.getSessionHistory(id)
        const messages = historyToMessages(history)
        const session = useSessionStore.getState().sessions.find((s) => s.id === id)
        const baseName = (session?.title?.trim() || 'session').replace(/[\\/:*?"<>|\n]/g, '_')
        let content: string
        let ext: string
        if (format === 'markdown') {
          ext = 'md'
          content = messages
            .map((message) => {
              const who =
                message.role === 'user'
                  ? 'User'
                  : message.role === 'assistant'
                    ? 'Assistant'
                    : 'System'
              return `## ${who}\n\n${message.content ?? ''}`
            })
            .join('\n\n---\n\n')
        } else {
          ext = 'json'
          content = JSON.stringify(messages, null, 2)
        }
        const filePath = await window.lmcodeAPI.saveTextFile({
          suggestedName: `${baseName}.${ext}`,
          content,
        })
        if (filePath) {
          addMessageToSession(id, {
            id: `sidebar_export_text_${globalThis.crypto.randomUUID()}`,
            role: 'system',
            variant: 'notice',
            content: `已导出为 ${format === 'markdown' ? 'Markdown' : 'JSON'}：\n\n\`${filePath}\``,
            timestamp: Date.now(),
          })
        }
      } catch (error) {
        console.error('Failed to export session text:', error)
        addMessageToSession(id, {
          id: `sidebar_export_text_error_${globalThis.crypto.randomUUID()}`,
          role: 'system',
          variant: 'error',
          content: `导出失败：${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        })
      }
    },
    [addMessageToSession],
  )

  const handleTogglePin = useCallback((id: string) => {
    setPinnedSessions((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSessionPinned(id, next.has(id))
      return next
    })
  }, [])

  const handleRename = useCallback(
    async (id: string, title: string) => {
      try {
        await window.lmcodeAPI.renameSession(id, title)
        setSessions(
          useSessionStore.getState().sessions.map((session) =>
            session.id === id ? { ...session, title } : session,
          ),
        )
      } catch (error) {
        console.error('Failed to rename session:', error)
      }
    },
    [setSessions],
  )

  return (
    <aside
      aria-label="任务侧栏"
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)] transition-[width] duration-200 ease-out',
        open ? 'w-72' : 'w-0',
      )}
    >
      <div className="flex h-full w-72 flex-col">
        <div className="flex h-[52px] items-center justify-between px-3">
          <div className="flex min-w-0 items-center gap-2.5 pl-0.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--lm-text-primary)] text-[12px] font-semibold text-[var(--lm-bg-base)] shadow-sm">
              L
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13px] font-semibold tracking-tight">LMCODE</div>
              <div className="text-[9px] font-medium uppercase tracking-[0.16em] text-[var(--lm-text-muted)]">
                Agent workspace
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggle}
            aria-label="收起侧栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="收起侧栏"
          >
            <PanelLeftClose size={17} />
          </button>
        </div>

        <div className="flex gap-1.5 px-3 pb-2 pt-1">
          <button
            type="button"
            onClick={clearCurrentSession}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--lm-accent)] px-3 py-2 text-[12.5px] font-medium text-[var(--lm-accent-fg)] shadow-sm transition-colors hover:bg-[var(--lm-accent-hover)]"
          >
            <Plus size={15} />
            <span>新建任务</span>
          </button>
          <button
            type="button"
            onClick={() => void createSession()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[var(--lm-text-secondary)] transition-colors hover:border-[var(--lm-border-strong)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="打开项目"
            aria-label="打开项目"
          >
            <FolderOpen size={16} />
          </button>
        </div>

        <ProjectPicker display="path" className="px-3 pb-2" />

        <div className="px-3 pb-1">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--lm-text-muted)]"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && visibleSessionIds.length > 0) {
                  event.preventDefault()
                  focusSession(visibleSessionIds[0])
                } else if (event.key === 'Escape') {
                  if (query) setQuery('')
                  else event.currentTarget.blur()
                }
              }}
              placeholder="搜索任务或项目"
              aria-label="搜索任务或项目"
              className="w-full rounded-lg border border-transparent bg-[var(--lm-bg-hover)] py-1.5 pl-8 pr-8 text-[12px] text-[var(--lm-text-primary)] placeholder:text-[var(--lm-text-muted)] transition-colors focus:border-[var(--lm-border-strong)] focus:bg-[var(--lm-bg-surface)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  searchInputRef.current?.focus()
                }}
                aria-label="清除搜索"
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-active)] hover:text-[var(--lm-text-primary)]"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {searching && (
            <div className="px-1 pt-1 text-[10px] text-[var(--lm-text-muted)]" role="status">
              {filtered.length > 0 ? `${filtered.length} 个匹配任务` : '没有匹配任务'}
            </div>
          )}
        </div>

        <nav aria-label="任务列表" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-0.5">
          {filtered.length === 0 && (
            <div className="mx-1 mt-5 rounded-xl border border-dashed border-[var(--lm-border-strong)] px-3 py-6 text-center">
              <Search size={18} className="mx-auto mb-2 text-[var(--lm-text-muted)]" />
              <p className="text-[11px] font-medium text-[var(--lm-text-secondary)]">
                {query.trim() ? '未找到匹配的任务' : '还没有任务'}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--lm-text-muted)]">
                {query.trim() ? '试试任务名或项目路径' : '新任务会按项目显示在这里'}
              </p>
            </div>
          )}

          {groupedSessions.map((group) => {
            const groupKey = group.workDir || '__no_project__'
            const isCollapsed = !searching && collapsedProjects.has(groupKey)
            const groupName = group.workDir ? projectDisplayName(group.workDir) : '未关联项目'
            const sessionIds = group.sessions.map((session) => session.id)
            return (
              <section key={groupKey} className="mb-1 mt-1" aria-label={groupName}>
                <div
                  className="group/project flex items-center gap-1 px-1.5 pb-1 pt-2"
                  title={group.workDir || '未关联项目'}
                >
                  <button
                    type="button"
                    onClick={() => toggleProjectCollapsed(groupKey)}
                    aria-expanded={!isCollapsed}
                    aria-label={isCollapsed ? `展开项目 ${groupName} 的任务` : `折叠项目 ${groupName} 的任务`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left text-[10.5px] font-medium text-[var(--lm-text-muted)] transition-colors hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]"
                  >
                    <ChevronRight
                      size={11}
                      className={cn('shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
                    />
                    <Folder size={11} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{groupName}</span>
                    <CollapsedProjectActivity sessionIds={sessionIds} visible={isCollapsed} />
                    <span className="shrink-0 tabular-nums text-[9px] text-[var(--lm-text-muted)]">
                      {group.sessions.length}
                    </span>
                  </button>
                  {group.workDir && (
                    <button
                      type="button"
                      onClick={() => {
                        expandProject(groupKey)
                        createSessionInProject(group.workDir)
                      }}
                      className="pointer-events-none flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--lm-text-muted)] opacity-0 transition-all hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                      title={`在 ${groupName} 中新建任务`}
                      aria-label={`在项目 ${group.workDir} 中新建任务`}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>

                {!isCollapsed && group.sessions.map((session) => (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    isCurrent={session.id === currentSessionId}
                    isPinned={pinnedSessions.has(session.id)}
                    activityLabel={formatSessionActivity(
                      session.updatedAt || session.createdAt,
                      activityNow,
                    )}
                    renameRequestNonce={
                      renameRequest?.sessionId === session.id ? renameRequest.nonce : null
                    }
                    pendingDeletion={pendingDeletion}
                    deletingId={deletingId}
                    onSelect={selectSession}
                    onRename={handleRename}
                    onExport={handleExport}
                    onExportText={handleExportText}
                    onTogglePin={handleTogglePin}
                    onDelete={handleDelete}
                    onNavigateKey={handleSessionNavigateKey}
                    registerButton={registerSessionButton}
                  />
                ))}
              </section>
            )
          })}
        </nav>

        <div className="border-t border-[var(--lm-border)] p-2">
          <button
            type="button"
            onClick={onOpenExtensions}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <Blocks size={14} />
            <span>技能与 MCP</span>
          </button>
          <button
            type="button"
            onClick={onOpenMemory}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <BookOpen size={14} />
            <span>记忆库</span>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <Settings size={14} />
            <span>设置</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
