import { useEffect, useState } from 'react'
import { Target, Pause, Play, CircleOff, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGoalStore } from '@/stores/goal-store'
import { useSessionStore } from '@/stores/session-store'
import type { GoalSnapshotData } from '@lmcode-cli/lmcode-sdk'

const GOAL_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: '执行中', color: 'text-[var(--lm-accent-text)]' },
  paused: { label: '已暂停', color: 'text-[var(--lm-warning)]' },
  blocked: { label: '受阻', color: 'text-[var(--lm-error)]' },
  complete: { label: '已完成', color: 'text-[var(--lm-success)]' },
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  }
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`
  return String(tokens)
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m`
}

function budgetText(goal: GoalSnapshotData): string | null {
  const { remainingTokens, remainingTurns, remainingWallClockMs } = goal.budget
  if (remainingTokens !== null) return `剩余 ${formatTokens(remainingTokens)} tokens`
  if (remainingTurns !== null) return `剩余 ${remainingTurns} 轮`
  if (remainingWallClockMs !== null) return `剩余 ${formatMs(remainingWallClockMs)}`
  return null
}

/**
 * 当前会话目标的常驻指示器：顶部栏显示目标摘要，点击展开操作面板
 * （状态 / 完成标准 / 轮次与预算 / 暂停 / 恢复 / 取消）。
 */
export function GoalChip() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const goal = useGoalStore((s) => (currentSessionId ? s.goals[currentSessionId] : undefined))
  const hydrateGoal = useGoalStore((s) => s.hydrateGoal)
  const pauseGoal = useGoalStore((s) => s.pauseGoal)
  const resumeGoal = useGoalStore((s) => s.resumeGoal)
  const cancelGoal = useGoalStore((s) => s.cancelGoal)
  const [open, setOpen] = useState(false)

  // 进入会话时水合一次目标；后续由 goal.updated 事件保持同步。
  useEffect(() => {
    if (!currentSessionId) return
    void hydrateGoal(currentSessionId)
  }, [currentSessionId, hydrateGoal])

  if (!currentSessionId || goal === undefined || goal === null) return null

  const status =
    GOAL_STATUS_CONFIG[goal.status] ?? { label: goal.status, color: 'text-[var(--lm-text-muted)]' }
  const budget = budgetText(goal)
  const interactive =
    goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked'

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`目标：${goal.objective}`}
        aria-label="当前目标"
        className="flex max-w-[280px] items-center gap-1.5 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-2.5 py-1.5 transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        <Target size={12} className={cn('shrink-0', status.color)} />
        <span className="truncate text-[12px] font-medium text-[var(--lm-text-primary)]">
          {goal.objective}
        </span>
        {budget && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--lm-text-muted)]">{budget}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-3 shadow-[var(--lm-shadow-pop)]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Target size={13} className={cn('shrink-0', status.color)} />
              <span className={cn('text-[11px] font-semibold uppercase tracking-wider', status.color)}>
                {status.label}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md p-0.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
              aria-label="关闭"
            >
              <X size={13} />
            </button>
          </div>

          <p className="mt-2 text-[13px] font-medium leading-snug text-[var(--lm-text-primary)]">
            {goal.objective}
          </p>
          {goal.completionCriterion && (
            <p className="mt-1 text-[12px] leading-snug text-[var(--lm-text-secondary)]">
              完成标准：{goal.completionCriterion}
            </p>
          )}

          <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
            <div className="rounded-lg bg-[var(--lm-bg-hover)] px-1 py-1.5">
              <p className="font-mono text-[13px] font-semibold text-[var(--lm-text-primary)]">
                {goal.turnsUsed}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--lm-text-muted)]">轮次</p>
            </div>
            <div className="rounded-lg bg-[var(--lm-bg-hover)] px-1 py-1.5">
              <p className="font-mono text-[13px] font-semibold text-[var(--lm-text-primary)]">
                {formatTokens(goal.tokensUsed)}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--lm-text-muted)]">已用 tokens</p>
            </div>
            <div className="rounded-lg bg-[var(--lm-bg-hover)] px-1 py-1.5">
              <p className="truncate font-mono text-[13px] font-semibold text-[var(--lm-text-primary)]">
                {budget ?? '—'}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--lm-text-muted)]">剩余预算</p>
            </div>
          </div>

          {interactive && (
            <div className="mt-2.5 flex gap-1.5">
              {goal.status === 'active' && (
                <button
                  onClick={() => void pauseGoal(currentSessionId)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[var(--lm-bg-hover)] px-2 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-text-primary)]"
                >
                  <Pause size={11} />
                  暂停
                </button>
              )}
              {goal.status === 'paused' && (
                <button
                  onClick={() => void resumeGoal(currentSessionId)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[var(--lm-bg-hover)] px-2 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-text-primary)]"
                >
                  <Play size={11} />
                  恢复
                </button>
              )}
              <button
                onClick={() => void cancelGoal(currentSessionId)}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[var(--lm-bg-hover)] px-2 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-error)]"
              >
                <CircleOff size={11} />
                取消目标
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
