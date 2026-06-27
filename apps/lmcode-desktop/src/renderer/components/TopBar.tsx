import { PanelLeftOpen, ListTodo, Sun, Moon, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { resolveTheme, type ThemePref } from '@/lib/theme'

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenTasks: () => void
  onOpenSettings: () => void
  theme: ThemePref
  onToggleTheme: () => void
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onOpenTasks,
  onOpenSettings,
  theme,
  onToggleTheme,
}: TopBarProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const permission = useSessionStore((s) => s.permission)
  const contextTokens = useSessionStore((s) => s.contextTokens)
  const maxContextTokens = useSessionStore((s) => s.maxContextTokens)

  const tasks = useTaskStore((s) => s.tasks)
  const runningCount = tasks.filter(
    (t) => t.status === 'running' || t.status === 'awaiting_approval',
  ).length

  const current = sessions.find((s) => s.id === currentSessionId)
  const title = current?.title || current?.workDir || '新对话'

  const pct =
    maxContextTokens > 0
      ? Math.min((contextTokens / maxContextTokens) * 100, 100)
      : 0

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

      {/* Context meter */}
      {maxContextTokens > 0 && (
        <div
          className="hidden items-center gap-2 rounded-full bg-[var(--lm-bg-hover)] px-3 py-1 sm:flex"
          title={`上下文 ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens（${Math.round(pct)}%）`}
        >
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--lm-border-strong)]">
            <div
              className="h-full rounded-full bg-[var(--lm-accent)] transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[11px] text-[var(--lm-text-secondary)]">
            {fmtTokens(contextTokens)} / {fmtTokens(maxContextTokens)}
            <span className="ml-1 text-[var(--lm-text-muted)]">({Math.round(pct)}%)</span>
          </span>
        </div>
      )}

      <span className={cn('text-[12px] font-medium', permissionColor)} title="权限模式">
        {permissionLabel}
      </span>

      <div className="mx-0.5 h-5 w-px bg-[var(--lm-border)]" />

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
