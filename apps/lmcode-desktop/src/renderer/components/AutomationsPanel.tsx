import { useCallback, useEffect, useState } from 'react'
import type { CronJobInfo } from '@lmcode-cli/lmcode-sdk'
import {
  AlertTriangle,
  CalendarClock,
  Clock3,
  Loader2,
  Plus,
  RefreshCw,
  Repeat2,
  Trash2,
  X,
} from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'

interface AutomationsPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

const SCHEDULE_PRESETS = [
  { cron: '*/15 * * * *', label: '每 15 分钟' },
  { cron: '0 * * * *', label: '每小时' },
  { cron: '0 9 * * *', label: '每天 09:00' },
  { cron: '0 9 * * 1-5', label: '工作日 09:00' },
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '暂无'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

export function AutomationsPanel({ open, onClose }: AutomationsPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const [jobs, setJobs] = useState<readonly CronJobInfo[]>([])
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [prompt, setPrompt] = useState('')
  const [recurring, setRecurring] = useState(true)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(null)
    try {
      setJobs(await window.lmcodeAPI.listCronJobs(sessionId))
    } catch (reason) {
      setJobs([])
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open || !sessionId) return
    return window.lmcodeAPI.onSessionEvent((payload) => {
      if (payload.sessionId === sessionId && payload.event.type === 'cron.fired') {
        void refresh()
      }
    })
  }, [open, refresh, sessionId])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const createJob = async (): Promise<void> => {
    if (!sessionId || !cron.trim() || !prompt.trim()) return
    setCreating(true)
    setError(null)
    try {
      await window.lmcodeAPI.createCronJob(sessionId, {
        cron: cron.trim(),
        prompt: prompt.trim(),
        recurring,
      })
      setPrompt('')
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  const deleteJob = async (id: string): Promise<void> => {
    if (!sessionId) return
    setDeletingId(id)
    setError(null)
    try {
      await window.lmcodeAPI.deleteCronJob(sessionId, id)
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingId(null)
    }
  }

  if (!open) return null

  const presetValue = SCHEDULE_PRESETS.some((preset) => preset.cron === cron) ? cron : 'custom'

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative z-10 ml-auto flex h-full w-[500px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <header className="flex items-center gap-2 border-b border-[var(--lm-border)] px-4 py-3.5">
          <CalendarClock size={16} className="text-[var(--lm-accent-text)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-[var(--lm-text-primary)]">自动化</h2>
            <p className="text-[10px] text-[var(--lm-text-muted)]">按计划把任务重新注入当前会话</p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
            title="刷新自动化"
          >
            <RefreshCw size={14} className={loading ? 'lm-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        {error && (
          <div className="flex items-start gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-accent-soft)] px-4 py-2 text-[11px] text-[var(--lm-error)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="border-b border-[var(--lm-border)] p-4">
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <select
              value={presetValue}
              onChange={(event) => {
                if (event.target.value !== 'custom') setCron(event.target.value)
              }}
              className="rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-2.5 py-2 text-[11px] text-[var(--lm-text-primary)]"
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset.cron} value={preset.cron}>{preset.label}</option>
              ))}
              <option value="custom">自定义 Cron</option>
            </select>
            <input
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder="分 时 日 月 周"
              className="rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-2.5 py-2 font-mono text-[11px] text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
            />
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={8_000}
            rows={4}
            placeholder="到点后让 LMCODE 做什么？例如：检查未提交变更并运行相关测试。"
            className="mt-2 w-full resize-none rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)] focus:border-[var(--lm-accent)]"
          />
          <div className="mt-2 flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-[10px] text-[var(--lm-text-secondary)]">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(event) => setRecurring(event.target.checked)}
                className="accent-[var(--lm-accent)]"
              />
              <Repeat2 size={11} /> 重复执行
            </label>
            <span className="text-[9px] text-[var(--lm-text-muted)]">
              使用本机时区；关闭重复后仅在下一次匹配时执行
            </span>
            <button
              onClick={() => void createJob()}
              disabled={creating || !cron.trim() || !prompt.trim()}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
            >
              {creating ? <Loader2 size={12} className="lm-spin" /> : <Plus size={12} />}
              创建
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && jobs.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--lm-text-muted)]">
              <Loader2 size={15} className="lm-spin" /> 正在读取自动化…
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <CalendarClock size={26} className="text-[var(--lm-text-muted)]" />
              <p className="text-[13px] text-[var(--lm-text-secondary)]">当前会话暂无自动化</p>
              <p className="max-w-xs text-[11px] text-[var(--lm-text-muted)]">
                创建后任务会持久化，并在桌面端运行期间按计划触发。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <article
                  key={job.id}
                  className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3"
                >
                  <div className="flex items-start gap-2">
                    <Clock3 size={14} className="mt-0.5 shrink-0 text-[var(--lm-accent-text)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[11px] font-medium text-[var(--lm-text-primary)]">
                          {job.humanSchedule}
                        </span>
                        <span className="rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[9px] text-[var(--lm-text-muted)]">
                          {job.recurring ? '重复' : '单次'}
                        </span>
                        {job.stale && (
                          <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[9px] text-[var(--lm-error)]">
                            已过期
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-[9px] text-[var(--lm-text-muted)]">
                        {job.cron} · {job.id}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
                        {job.prompt}
                      </p>
                      <div className="mt-2 flex gap-3 text-[9px] text-[var(--lm-text-muted)]">
                        <span>下次：{formatTime(job.nextFireAt)}</span>
                        {job.lastFiredAt !== undefined && <span>上次：{formatTime(job.lastFiredAt)}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => void deleteJob(job.id)}
                      disabled={deletingId === job.id}
                      className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)] disabled:opacity-40"
                      title="删除自动化"
                    >
                      {deletingId === job.id ? <Loader2 size={13} className="lm-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
