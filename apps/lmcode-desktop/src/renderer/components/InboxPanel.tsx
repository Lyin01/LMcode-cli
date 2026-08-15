import { useEffect, useRef } from 'react'
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCheck,
  CheckCircle2,
  FileText,
  MessageSquare,
  Target,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { activateModalPanel } from '@/lib/modal-panel-controller'
import {
  totalUnreadCount,
  useInboxStore,
  type InboxItem,
  type InboxItemType,
} from '@/stores/inbox-store'
import { useArtifactsStore } from '@/stores/artifacts-store'
import { useSessionStore } from '@/stores/session-store'
import { formatSessionActivity, sessionDisplayTitle } from '@/lib/session-list'

interface InboxPanelProps {
  open: boolean
  onClose: () => void
}

const TYPE_ICON: Record<InboxItemType, typeof MessageSquare> = {
  'turn-completed': MessageSquare,
  'approval-pending': AlertTriangle,
  'subagent-finished': Bot,
  'task-finished': Terminal,
  'goal-update': Target,
  'artifact-updated': FileText,
}

function outcomeClass(item: InboxItem): string {
  if (item.outcome === 'failure') return 'text-[var(--lm-error)]'
  if (item.outcome === 'success') return 'text-[var(--lm-success)]'
  if (item.type === 'approval-pending') return 'text-[var(--lm-warning)]'
  return 'text-[var(--lm-accent-text)]'
}

function OutcomeBadge({ item }: { readonly item: InboxItem }) {
  if (item.outcome === 'success') {
    return <CheckCircle2 size={12} className="shrink-0 text-[var(--lm-success)]" />
  }
  if (item.outcome === 'failure') {
    return <XCircle size={12} className="shrink-0 text-[var(--lm-error)]" />
  }
  return null
}

function InboxEntry({
  item,
  onOpen,
}: {
  readonly item: InboxItem
  readonly onOpen: (item: InboxItem) => void
}) {
  const sessionTitle = useSessionStore((state) => {
    if (!item.sessionId) return null
    const session = state.sessions.find((entry) => entry.id === item.sessionId)
    return session ? sessionDisplayTitle(session) : null
  })
  const TypeIcon = TYPE_ICON[item.type]

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        'flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-[var(--lm-bg-hover)]',
        !item.read && 'bg-[var(--lm-accent-soft)]/40',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', outcomeClass(item))}>
        <TypeIcon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12.5px] text-[var(--lm-text-primary)]',
              !item.read && 'font-medium',
            )}
          >
            {item.title}
          </span>
          <OutcomeBadge item={item} />
        </span>
        {item.body && (
          <span className="mt-0.5 line-clamp-2 block text-[11px] text-[var(--lm-text-secondary)]">
            {item.body}
          </span>
        )}
        <span className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--lm-text-muted)]">
          {sessionTitle && <span className="max-w-[160px] truncate">{sessionTitle}</span>}
          {sessionTitle && <span>·</span>}
          <span>{formatSessionActivity(item.createdAt)}</span>
        </span>
      </span>
      {!item.read && (
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lm-accent-text)]" />
      )}
    </button>
  )
}

export function InboxPanel({ open, onClose }: InboxPanelProps) {
  const items = useInboxStore((state) => state.items)
  const markAllRead = useInboxStore((state) => state.markAllRead)
  const clear = useInboxStore((state) => state.clear)
  const panelRef = useRef<HTMLDivElement>(null)
  // Stable close callback for the modal controller: the effect below must not
  // tear down (and wrongly restore focus) just because the parent re-rendered
  // and produced a new onClose identity while the panel is open.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Modal lifecycle: initial focus, Escape closes, Tab rings inside the
  // panel, and closing restores focus to the bell that opened the drawer.
  useEffect(() => {
    if (!open || !panelRef.current) return
    return activateModalPanel(panelRef.current, { onClose: () => onCloseRef.current() })
  }, [open])

  if (!open) return null

  const unreadCount = totalUnreadCount(items)

  const handleOpenItem = (item: InboxItem): void => {
    useInboxStore.getState().markRead(item.id)
    if (item.sessionId) {
      useSessionStore.getState().selectSession(item.sessionId)
    }
    // artifact 条目的 id 编码了 artifactId（`artifact:<id>`，见 artifact-feed），
    // 点击时直接打开文档审阅面板。
    if (item.type === 'artifact-updated' && item.id.startsWith('artifact:')) {
      useArtifactsStore.getState().openPanel(item.id.slice('artifact:'.length))
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-inbox-panel-title"
        className="relative z-10 ml-auto flex h-full w-[400px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-[var(--lm-accent-text)]" />
            <h2
              id="lm-inbox-panel-title"
              className="text-[15px] font-semibold text-[var(--lm-text-primary)]"
            >
              通知中心
            </h2>
            {unreadCount > 0 && (
              <span className="rounded-full bg-[var(--lm-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--lm-accent-text)]">
                {unreadCount} 未读
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="全部标为已读"
              title="全部标为已读"
              data-lm-autofocus="true"
              disabled={unreadCount === 0}
              onClick={markAllRead}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <CheckCheck size={15} />
            </button>
            <button
              type="button"
              aria-label="清空通知"
              title="清空通知"
              disabled={items.length === 0}
              onClick={clear}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Trash2 size={15} />
            </button>
            <button
              type="button"
              aria-label="关闭通知中心"
              title="关闭通知中心"
              onClick={onClose}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <Bell size={28} className="text-[var(--lm-text-muted)]" />
              <p className="text-[14px] text-[var(--lm-text-secondary)]">没有新通知</p>
              <p className="text-[12px] text-[var(--lm-text-muted)]">
                后台任务完成、审批请求和子代理动态会显示在这里
              </p>
            </div>
          )}

          {items.length > 0 && (
            <div className="divide-y divide-[var(--lm-border)]">
              {items.map((item) => (
                <InboxEntry key={item.id} item={item} onOpen={handleOpenItem} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="border-t border-[var(--lm-border)] px-4 py-2.5">
            <p className="text-[11px] text-[var(--lm-text-muted)]">
              共 {items.length} 条通知{unreadCount > 0 && `（${unreadCount} 条未读）`}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
