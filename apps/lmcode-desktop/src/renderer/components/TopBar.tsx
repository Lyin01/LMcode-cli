import {
  GitCompareArrows,
  GitFork,
  Bot,
  CalendarClock,
  ListTodo,
  Moon,
  PanelLeftOpen,
  SlidersHorizontal,
  SquareTerminal,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { resolveTheme, type ThemePref } from '@/lib/theme'
import { evaluateContextPressure } from '@/lib/usage'

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
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const permission = useSessionStore((s) => s.permission)
  const contextTokens = useSessionStore((s) => s.contextTokens)
  const maxContextTokens = useSessionStore((s) => s.maxContextTokens)
  const usage = useSessionStore((s) => s.usage)

  const tasks = useTaskStore((s) => s.tasks)
  const runningCount = tasks.filter(
    (t) => t.status === 'running' || t.status === 'awaiting_approval',
  ).length
  const runningAgents = useSubagentStore((state) => state.agents).filter(
    (agent) => agent.sessionId === currentSessionId && agent.status === 'running',
  ).length

  const current = sessions.find((s) => s.id === currentSessionId)
  const title = current?.title || current?.workDir || '新对话'

  const pressure = evaluateContextPressure(contextTokens, maxContextTokens)

  const contextTooltip = `上下文 ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens（${Math.round(pressure.percentage)}% · ${pressure.level === 'critical' ? '⚠️ 水位极高' : pressure.level === 'warning' ? '⚡ 水位偏高' : '正常'}）${
    usage
      ? `\n输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} · 缓存读 ${usage.cacheReadTokens.toLocaleString()} · 缓存写 ${usage.cacheWriteTokens.toLocaleString()}`
      : ''
  }`

  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
    return String(n)
  }

  const permissionLabel =
    permission === 'yolo' ? 'YOLO' : permission === 'auto' ? '自动' : '手动'
  const permissionColor =
    permission === 'yolo'
      ? 'text-[var(--lm-error)]'
      : permission === 'auto'
        ? 'text-[var(--lm-success)]'
        : 'text-[var(--lm-warning)]'

  const isDark = resolveTheme(theme) === 'dark'

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-3">
      {!sidebarOpen && (
        <button
          onClick={onToggleSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          title="展开侧栏"
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--lm-text-primary)]">
        {title}
      </h1>

      {/* Token Meter with Pressure Visualization (modeled after deepseek-harness) */}
      {maxContextTokens > 0 && (
        <div
          className={cn(
            'hidden items-center gap-2 rounded-full px-3 py-1 transition-colors sm:flex',
            pressure.level === 'critical'
              ? 'bg-[var(--lm-error)]/10 ring-1 ring-[var(--lm-error)]/30'
              : pressure.level === 'warning'
                ? 'bg-[var(--lm-warning)]/10 ring-1 ring-[var(--lm-warning)]/30'
                : 'bg-[var(--lm-bg-hover)]',
          )}
          title={contextTooltip}
        >
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--lm-border-strong)]">
            <div
              className={cn('h-full rounded-full transition-all duration-300', pressure.bgClass)}
              style={{ width: `${pressure.percentage}%` }}
            />
          </div>
          <span
            className={cn(
              'font-mono text-[11px]',
              pressure.level === 'critical'
                ? 'font-semibold text-[var(--lm-error)]'
                : pressure.level === 'warning'
                  ? 'font-medium text-[var(--lm-warning)]'
                  : 'text-[var(--lm-text-secondary)]',
            )}
          >
            {fmtTokens(contextTokens)} / {fmtTokens(maxContextTokens)}
            <span className="ml-1 text-[var(--lm-text-muted)]">({Math.round(pressure.percentage)}%)</span>
            {usage && (
              <span className="ml-1 text-[var(--lm-text-muted)]">
                · ↓{fmtTokens(usage.outputTokens)}
              </span>
            )}
          </span>
        </div>
      )}

      <span className={cn('text-[12px] font-medium', permissionColor)} title="权限模式">
        {permissionLabel}
      </span>

      <div className="mx-0.5 h-5 w-px bg-[var(--lm-border)]" />

      <button
        onClick={onOpenGitReview}
        disabled={!currentSessionId}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="Git 变更审阅"
      >
        <GitCompareArrows size={18} />
      </button>

      <button
        onClick={onOpenTerminal}
        disabled={!currentSessionId}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="项目终端"
      >
        <SquareTerminal size={18} />
      </button>

      <button
        onClick={onOpenWorktrees}
        disabled={!currentSessionId}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="Git 工作树"
      >
        <GitFork size={18} />
      </button>

      <button
        onClick={onOpenSubagents}
        disabled={!currentSessionId}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="子 Agent"
      >
        <Bot size={18} />
        {runningAgents > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--lm-accent)] px-1 text-[10px] font-semibold text-[var(--lm-accent-fg)]">
            {runningAgents}
          </span>
        )}
      </button>

      <button
        onClick={onOpenAutomations}
        disabled={!currentSessionId}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="自动化"
      >
        <CalendarClock size={18} />
      </button>

      <button
        onClick={onOpenTasks}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        title="后台任务"
      >
        <ListTodo size={18} />
        {runningCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--lm-accent)] px-1 text-[10px] font-semibold text-[var(--lm-accent-fg)]">
            {runningCount}
          </span>
        )}
      </button>

      <button
        onClick={onToggleTheme}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        title={isDark ? '切换到亮色' : '切换到暗色'}
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <button
        onClick={onOpenSettings}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        title="设置"
      >
        <SlidersHorizontal size={17} />
      </button>
    </header>
  )
}
