import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import {
  Bot,
  CalendarClock,
  GitCompareArrows,
  GitFork,
  ListTodo,
  Moon,
  MoreHorizontal,
  PanelLeftOpen,
  Settings,
  SquareTerminal,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { resolveTheme, type ThemePref } from '@/lib/theme'
import { isNoProjectWorkDir, projectDisplayName } from '@/lib/projects'

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenTasks: () => void
  onOpenGitReview: () => void
  onOpenTerminal: () => void
  onOpenWorktrees: () => void
  onOpenSubagents: () => void
  onOpenAutomations: () => void
  onOpenSettings: () => void
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
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  )
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onOpenTasks,
  onOpenGitReview,
  onOpenTerminal,
  onOpenWorktrees,
  onOpenSubagents,
  onOpenAutomations,
  onOpenSettings,
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
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-3">
      {!sidebarOpen && (
        <TopBarAction label="展开侧栏" onClick={onToggleSidebar}>
          <PanelLeftOpen size={18} />
        </TopBarAction>
      )}

      <div className="min-w-0 flex-1 leading-tight">
        <h1 className="truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
          {title}
        </h1>
        <p className="mt-0.5 truncate text-[10px] text-[var(--lm-text-muted)]">
          {locationLabel}
        </p>
      </div>

      {currentSessionId && maxContextTokens > 0 && (
        <div
          className="hidden items-center gap-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-2.5 py-1.5 lg:flex"
          title={`上下文 ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens（${Math.round(contextPercentage)}%）`}
        >
          <div className="h-1 w-12 overflow-hidden rounded-full bg-[var(--lm-bg-active)]">
            <div
              className="h-full rounded-full bg-[var(--lm-accent-text)] transition-[width] duration-300"
              style={{ width: `${contextPercentage}%` }}
            />
          </div>
          <span className="font-mono text-[10px] tabular-nums text-[var(--lm-text-muted)]">
            {formatTokens(contextTokens)} / {formatTokens(maxContextTokens)}
          </span>
        </div>
      )}

      {currentSessionId && (
        <span
          className="hidden items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium text-[var(--lm-text-secondary)] sm:flex"
          title="当前权限模式"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', permissionColor)} />
          {permissionLabel}
        </span>
      )}

      <div className="mx-0.5 h-5 w-px bg-[var(--lm-border)]" />

      <TopBarAction
        label={isNoProject ? '审查 Git 变更（未关联项目时不可用）' : '审查 Git 变更'}
        disabled={!currentSessionId || isNoProject}
        onClick={onOpenGitReview}
      >
        <GitCompareArrows size={17} />
      </TopBarAction>
      <TopBarAction
        label="打开项目终端"
        disabled={!currentSessionId}
        onClick={onOpenTerminal}
      >
        <SquareTerminal size={17} />
      </TopBarAction>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="更多工作区工具"
            title="更多工作区工具"
            className="relative flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] outline-none transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]"
          >
            <MoreHorizontal size={18} />
            {attentionCount > 0 && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--lm-accent-text)]" />
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
              工作区工具
            </DropdownMenu.Label>
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
