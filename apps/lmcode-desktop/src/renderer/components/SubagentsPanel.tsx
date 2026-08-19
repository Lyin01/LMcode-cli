import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Eraser,
  Loader2,
  Send,
  Square,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useSubagentStore, type SubagentEntry } from '@/stores/subagent-store'
import { useTaskStore } from '@/stores/task-store'

interface SubagentsPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

function elapsed(entry: SubagentEntry): string {
  const end = entry.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.floor((end - entry.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SubagentsPanel({ open, onClose }: SubagentsPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const addMessageToSession = useSessionStore((state) => state.addMessageToSession)
  const agents = useSubagentStore((state) => state.agents)
  const clearCompleted = useSubagentStore((state) => state.clearCompleted)
  const tasks = useTaskStore((state) => state.tasks)
  const [directions, setDirections] = useState<Record<string, string>>({})
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const visibleAgents = useMemo(
    () => agents.filter((agent) => agent.sessionId === sessionId),
    [agents, sessionId],
  )
  const runningCount = visibleAgents.filter((agent) => agent.status === 'running').length

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const stopAgent = async (agent: SubagentEntry): Promise<void> => {
    setBusyAgent(agent.subagentId)
    setError(null)
    try {
      const task = tasks.find(
        (candidate) =>
          candidate.sessionId === agent.sessionId &&
          candidate.agentId === agent.subagentId &&
          (candidate.status === 'running' || candidate.status === 'awaiting_approval'),
      )
      if (task) {
        await window.lmcodeAPI.stopTask(task.sessionId, task.taskId)
      } else {
        await window.lmcodeAPI.cancelResponse(agent.sessionId)
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAgent(null)
    }
  }

  const steerAgent = async (agent: SubagentEntry): Promise<void> => {
    const direction = directions[agent.subagentId]?.trim()
    if (!direction) return
    setBusyAgent(agent.subagentId)
    setError(null)
    try {
      const instruction = `请调整子 Agent ${agent.name}（${agent.subagentId}）的工作方向：${direction}`
      await window.lmcodeAPI.steerMessage(agent.sessionId, {
        text: instruction,
        attachments: [],
      })
      addMessageToSession(agent.sessionId, {
        id: `msg_subagent_steer_${Date.now()}`,
        role: 'user',
        content: instruction,
        timestamp: Date.now(),
      })
      setDirections((current) => ({ ...current, [agent.subagentId]: '' }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAgent(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-x-0 top-0 bottom-[var(--lm-global-usage-height)] z-40 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative z-10 ml-auto flex h-full w-[440px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <header className="flex items-center gap-2 border-b border-[var(--lm-border)] px-4 py-3.5">
          <Bot size={16} className="text-[var(--lm-accent-text)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-[var(--lm-text-primary)]">子 Agent</h2>
            <p className="text-[10px] text-[var(--lm-text-muted)]">
              {runningCount > 0 ? `${runningCount} 个正在运行` : '查看并调整并行任务'}
            </p>
          </div>
          {visibleAgents.some((agent) => agent.status !== 'running') && sessionId && (
            <button
              onClick={() => clearCompleted(sessionId)}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
              title="清除已结束记录"
            >
              <Eraser size={14} />
            </button>
          )}
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

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {visibleAgents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Bot size={26} className="text-[var(--lm-text-muted)]" />
              <p className="text-[13px] text-[var(--lm-text-secondary)]">当前会话暂无子 Agent</p>
              <p className="max-w-xs text-[11px] text-[var(--lm-text-muted)]">
                主 Agent 启动探索、验证或并行任务后，运行状态会实时显示在这里。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleAgents.map((agent) => {
                const busy = busyAgent === agent.subagentId
                const activeTask = tasks.find(
                  (task) => task.sessionId === agent.sessionId && task.agentId === agent.subagentId,
                )
                return (
                  <article
                    key={agent.subagentId}
                    className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3"
                  >
                    <div className="flex items-start gap-2">
                      <span className={cn(
                        'mt-0.5',
                        agent.status === 'completed' && 'text-[var(--lm-success)]',
                        agent.status === 'failed' && 'text-[var(--lm-error)]',
                        agent.status === 'running' && 'text-[var(--lm-accent-text)]',
                      )}>
                        {agent.status === 'running' ? (
                          <Loader2 size={14} className="lm-spin" />
                        ) : agent.status === 'completed' ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <XCircle size={14} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-medium text-[var(--lm-text-primary)]">{agent.name}</span>
                          {agent.runInBackground && (
                            <span className="rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[9px] text-[var(--lm-text-muted)]">
                              后台
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-1 text-[9px] text-[var(--lm-text-muted)]">
                            <Clock size={9} /> {elapsed(agent)}
                          </span>
                        </div>
                        <p className="mt-0.5 font-mono text-[9px] text-[var(--lm-text-muted)]">
                          {agent.subagentId}
                        </p>
                        {agent.description && (
                          <p className="mt-1 text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
                            {agent.description}
                          </p>
                        )}
                      </div>
                    </div>

                    {agent.status === 'running' && (
                      <div className="mt-2 border-t border-[var(--lm-border)] pt-2">
                        <div className="flex gap-1.5">
                          <input
                            value={directions[agent.subagentId] ?? ''}
                            onChange={(event) => setDirections((current) => ({
                              ...current,
                              [agent.subagentId]: event.target.value,
                            }))}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void steerAgent(agent)
                            }}
                            placeholder="补充方向，通知主 Agent 调整…"
                            className="min-w-0 flex-1 rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2 py-1.5 text-[10px] text-[var(--lm-text-primary)]"
                          />
                          <button
                            onClick={() => void steerAgent(agent)}
                            disabled={busy || !(directions[agent.subagentId]?.trim())}
                            className="rounded-lg bg-[var(--lm-accent)] p-1.5 text-[var(--lm-accent-fg)] disabled:opacity-40"
                            title="通知主 Agent 调整"
                          >
                            <Send size={12} />
                          </button>
                          <button
                            onClick={() => void stopAgent(agent)}
                            disabled={busy}
                            className="rounded-lg border border-[var(--lm-border-strong)] p-1.5 text-[var(--lm-text-muted)] hover:text-[var(--lm-error)] disabled:opacity-40"
                            title={activeTask ? '停止后台子 Agent' : '停止包含该子 Agent 的当前回合'}
                          >
                            <Square size={11} fill="currentColor" />
                          </button>
                        </div>
                      </div>
                    )}

                    {agent.resultSummary && (
                      <details className="mt-2 border-t border-[var(--lm-border)] pt-2">
                        <summary className="cursor-pointer text-[10px] font-medium text-[var(--lm-text-muted)]">
                          查看结果摘要
                        </summary>
                        <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
                          {agent.resultSummary}
                        </p>
                      </details>
                    )}
                    {agent.error && (
                      <p className="mt-2 border-t border-[var(--lm-border)] pt-2 text-[11px] text-[var(--lm-error)]">
                        {agent.error}
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
