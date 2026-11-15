import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import {
  Bell,
  Bot,
  CalendarClock,
  FlaskConical,
  GitCompareArrows,
  GitFork,
  ListTodo,
  Moon,
  MoreHorizontal,
  PanelLeftOpen,
  QrCode,
  Settings,
  SquareTerminal,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { totalUnreadCount, useInboxStore } from '@/stores/inbox-store'
import { resolveTheme, type ThemePref } from '@/lib/theme'
import { isNoProjectWorkDir, projectDisplayName } from '@/lib/projects'
import { GoalChip } from '@/components/GoalChip'

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenInbox: () => void
  onOpenTasks: () => void
  onOpenGitReview: () => void
  onOpenTerminal: () => void
  onOpenWorktrees: () => void
  onOpenSubagents: () => void
  onOpenAutomations: () => void
  onOpenSettings: () => void
  onOpenRemote: () => void
  onOpenPurge: () => void
  theme: ThemePref
  onToggleTheme: () => void
}

const menuItemClass =
  'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)] data-[disabled]:opacity-40'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  }
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`
  return String(tokens)
}

function TopBarAction({
  label,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors duration-150 hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  )
}

/**
 * Slim conversation header: the session title carries the chrome, and every
 * workspace tool lives in the "更多" menu (or the sidebar), so the transcript
 * gets the visual weight instead of a row of nine icons.
 */
export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onOpenInbox,
  onOpenTasks,
  onOpenGitReview,
  onOpenTerminal,
  onOpenWorktrees,
  onOpenSubagents,
  onOpenAutomations,
  onOpenSettings,
  onOpenRemote,
  onOpenPurge,
  theme,
  onToggleTheme,
}: TopBarProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const current = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.currentSessionId),
  )
  const permission = useSessionStore((state) => state.permission)
  const contextTokens = useSessionStore((state) => state.contextTokens)
  const maxContextTokens = useSessionStore((state) => state.maxContextTokens)
  const noProjectWorkDir = useSessionStore((state) => state.noProjectWorkDir)

  const runningCount = useTaskStore(
    (state) => state.tasks.filter(
      (task) => task.status === 'running' || task.status === 'awaiting_approval',
    ).length,
  )
  const runningAgents = useSubagentStore(
    (state) => state.agents.filter(
      (agent) => agent.sessionId === currentSessionId && agent.status === 'running',
    ).length,
  )
  const inboxUnread = useInboxStore((state) => totalUnreadCount(state.items))

  const isNoProject = isNoProjectWorkDir(current?.workDir, noProjectWorkDir)
  const title = current?.title?.trim() || '新任务'
  const locationLabel = !currentSessionId
    ? '选择项目后开始'
    : isNoProject
      ? '未关联项目'
      : current?.workDir
        ? projectDisplayName(current.workDir)
        : '正在加载项目'

  const contextPercentage =
    maxContextTokens > 0
      ? Math.min((contextTokens / maxContextTokens) * 100, 100)
      : 0
  const permissionLabel =
    permission === 'yolo' ? 'YOLO' : permission === 'auto' ? '自动' : '手动'
  const permissionColor =
    permission === 'yolo'
      ? 'bg-[var(--lm-error)]'
      : permission === 'auto'
        ? 'bg-[var(--lm-success)]'
        : 'bg-[var(--lm-warning)]'
  const isDark = resolveTheme(theme) === 'dark'
  const attentionCount = runningCount + runningAgents

  return (
    <header
      data-ui="header"
      className="flex h-11 shrink-0 items-center gap-1.5 bg-[var(--lm-bg-base)] pl-4 pr-2.5"
    >
      {!sidebarOpen && (
        <TopBarAction label="展开侧栏" onClick={onToggleSidebar}>
          <PanelLeftOpen size={17} />
        </TopBarAction>
      )}

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-[13px] font-medium tracking-[-0.01em] text-[var(--lm-text-primary)]">
          {title}
        </h1>
        <span className="hidden min-w-0 items-center gap-1.5 text-[11px] text-[var(--lm-text-muted)] sm:flex">
          <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--lm-text-muted)]" />
          <span className="truncate">{locationLabel}</span>
        </span>
      </div>

      {currentSessionId && maxContextTokens > 0 && (
        <div
          className="hidden items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px] tabular-nums text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] lg:flex"
          title={`上下文 ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens（${Math.round(contextPercentage)}%）`}
        >
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90">
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="var(--lm-border-strong)" strokeWidth="1.7" />
              <circle
                cx="8"
                cy="8"
                r="6.4"
                fill="none"
                stroke="var(--lm-accent)"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeDasharray={`${(contextPercentage / 100) * 40.2} 40.2`}
              />
            </svg>
          </span>
          <span className="font-mono">
            {formatTokens(contextTokens)} / {formatTokens(maxContextTokens)}
          </span>
        </div>
      )}

      <GoalChip />

      {currentSessionId && (
        <span
          className="hidden items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px] font-medium text-[var(--lm-text-secondary)] sm:flex"
          title="当前权限模式（Shift+Tab 切换）"
          aria-live="polite"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', permissionColor)} />
          {permissionLabel}
        </span>
      )}

      <TopBarAction
        label={inboxUnread > 0 ? `通知中心（${inboxUnread} 条未读）` : '通知中心'}
        onClick={onOpenInbox}
      >
        <span className="relative">
          <Bell size={16} />
          {inboxUnread > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--lm-accent-text)] px-0.5 text-[8px] font-semibold text-[var(--lm-bg-base)]">
              {inboxUnread > 99 ? '99+' : inboxUnread}
            </span>
          )}
        </span>
      </TopBarAction>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="更多工作区工具"
            title="更多工作区工具"
            className="relative flex h-7 w-7 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]"
          >
            <MoreHorizontal size={17} />
            {attentionCount > 0 && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--lm-accent-text)]" />
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-50 min-w-52 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-pop)]"
          >
            <DropdownMenu.Label className="px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--lm-text-muted)]">
              工作区
            </DropdownMenu.Label>
            <DropdownMenu.Item
              disabled={!currentSessionId || isNoProject}
              onSelect={onOpenGitReview}
              className={menuItemClass}
            >
              <GitCompareArrows size={15} />
              <span className="flex-1">Git 审查</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={!currentSessionId}
              onSelect={onOpenTerminal}
              className={menuItemClass}
            >
              <SquareTerminal size={15} />
              <span className="flex-1">项目终端</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={!currentSessionId || isNoProject}
              onSelect={onOpenWorktrees}
              className={menuItemClass}
            >
              <GitFork size={15} />
              <span className="flex-1">工作树</span>
              <span className="text-[9px] text-[var(--lm-text-muted)]">隔离任务</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={!currentSessionId}
              onSelect={onOpenSubagents}
              className={menuItemClass}
            >
              <Bot size={15} />
              <span className="flex-1">子 Agent</span>
              {runningAgents > 0 && (
                <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--lm-accent-text)]">
                  {runningAgents} 运行中
                </span>
              )}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={!currentSessionId}
              onSelect={onOpenAutomations}
              className={menuItemClass}
            >
              <CalendarClock size={15} />
              <span className="flex-1">自动化</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onOpenTasks} className={menuItemClass}>
              <ListTodo size={15} />
              <span className="flex-1">后台任务</span>
              {runningCount > 0 && (
                <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--lm-accent-text)]">
                  {runningCount}
                </span>
              )}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--lm-border)]" />
            <DropdownMenu.Item onSelect={onOpenRemote} className={menuItemClass}>
              <QrCode size={15} />
              <span className="flex-1">远程连接（手机扫码）</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onOpenPurge} className={menuItemClass}>
              <FlaskConical size={15} />
              <span className="flex-1">清洗（Purge）</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--lm-border)]" />
            <DropdownMenu.Item onSelect={onToggleTheme} className={menuItemClass}>
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
              <span className="flex-1">{isDark ? '切换到亮色' : '切换到暗色'}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onOpenSettings} className={menuItemClass}>
              <Settings size={15} />
              <span className="flex-1">设置</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  )
}
