import { useEffect, useRef } from 'react'
import { X, Terminal, Square, Clock, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTaskStore, type TaskEntry } from '@/stores/task-store'

interface TasksPanelProps {
  open: boolean
  onClose: () => void
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now()
  const diff = end - startedAt
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

const STATUS_CONFIG: Record<
  TaskEntry['status'],
  { icon: React.ReactNode; label: string; color: string }
> = {
  running: { icon: <Loader2 size={13} className="lm-spin" />, label: '运行中', color: 'text-[var(--lm-accent-text)]' },
  awaiting_approval: { icon: <AlertTriangle size={13} />, label: '等待审批', color: 'text-[var(--lm-warning)]' },
  completed: { icon: <CheckCircle2 size={13} />, label: '已完成', color: 'text-[var(--lm-success)]' },
  failed: { icon: <XCircle size={13} />, label: '失败', color: 'text-[var(--lm-error)]' },
  killed: { icon: <XCircle size={13} />, label: '已终止', color: 'text-[var(--lm-error)]' },
  lost: { icon: <AlertTriangle size={13} />, label: '丢失', color: 'text-[var(--lm-text-muted)]' },
}

function TaskCard({ task }: { task: TaskEntry }) {
  const cfg = STATUS_CONFIG[task.status]
  const isActive = task.status === 'running' || task.status === 'awaiting_approval'

  const handleStop = async () => {
    try {
      await window.lmcodeAPI.stopTask(task.taskId)
    } catch (err) {
      console.error('Failed to stop task:', err)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal size={13} className="shrink-0 text-[var(--lm-text-muted)]" />
          <span className="truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
            {task.description || task.command}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--lm-bg-hover)] px-2 py-0.5">
          <span className={cfg.color}>{cfg.icon}</span>
          <span className={cn('text-[10px] font-medium', cfg.color)}>{cfg.label}</span>
        </div>
      </div>

      {task.description && task.command && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-[var(--lm-text-muted)]">{task.command}</p>
      )}

      <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--lm-text-muted)]">
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {formatDuration(task.startedAt, task.endedAt)}
        </span>
        {task.pid > 0 && <span className="font-mono">PID: {task.pid}</span>}
        {task.exitCode !== null && task.status !== 'running' && (
          <span className={cn('font-mono', task.exitCode === 0 ? 'text-[var(--lm-success)]' : 'text-[var(--lm-error)]')}>
            退出码: {task.exitCode}
          </span>
        )}
      </div>

      {isActive && (
        <button
          onClick={handleStop}
          className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-error)]"
        >
          <Square size={10} />
          停止任务
        </button>
      )}

      {task.status === 'killed' && task.stopReason && (
        <p className="mt-1.5 text-[10px] text-[var(--lm-text-muted)]">原因: {task.stopReason}</p>
      )}
    </div>
  )
}

export function TasksPanel({ open, onClose }: TasksPanelProps) {
  const tasks = useTaskStore((s) => s.tasks)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open && panelRef.current) panelRef.current.focus()
  }, [open])

  const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'awaiting_approval')
  const completedTasks = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'killed' || t.status === 'lost',
  )

  if (!open) return null

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="fixed bottom-4 left-1/2 z-30 max-h-[60vh] w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-pop)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Terminal size={15} className="text-[var(--lm-text-secondary)]" />
          <h3 className="text-[14px] font-medium text-[var(--lm-text-primary)]">后台任务</h3>
          {activeTasks.length > 0 && (
            <span className="rounded-full bg-[var(--lm-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--lm-accent-text)]">
              {activeTasks.length} 运行中
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="max-h-[calc(60vh-52px)] overflow-y-auto p-3">
        {tasks.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Terminal size={24} className="text-[var(--lm-text-muted)]" />
            <p className="text-[14px] text-[var(--lm-text-secondary)]">暂无后台任务</p>
            <p className="text-[12px] text-[var(--lm-text-muted)]">AI 运行后台命令时，任务将显示在这里</p>
          </div>
        )}

        {activeTasks.length > 0 && (
          <div className="mb-3">
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">运行中</h4>
            <div className="space-y-2">
              {activeTasks.map((task) => <TaskCard key={task.taskId} task={task} />)}
            </div>
          </div>
        )}

        {completedTasks.length > 0 && (
          <div>
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">已完成</h4>
            <div className="space-y-2">
              {completedTasks.map((task) => <TaskCard key={task.taskId} task={task} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
