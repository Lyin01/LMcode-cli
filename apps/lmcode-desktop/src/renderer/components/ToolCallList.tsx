import { useEffect, useMemo, useState } from 'react'
import type { ToolCallInfo } from '@/types'
import { ToolCallBlock } from '@/components/ToolCallBlock'
import { toolFamily, summarizeToolArgs } from '@/lib/tool-summary'
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from 'lucide-react'

/** 连续同类调用达到该数量时折叠成一组（Flash 模型常连发几十个 Bash）。 */
const GROUP_THRESHOLD = 3

interface Run {
  readonly key: string
  readonly title: string
  readonly calls: ToolCallInfo[]
}

function runKeyOf(call: ToolCallInfo): string {
  const family = toolFamily(call.toolName, call.args)
  return family === 'other' ? `other:${call.toolName}` : family
}

function displayTitle(key: string, call: ToolCallInfo): string {
  const family = key.startsWith('other:') ? 'other' : key
  switch (family) {
    case 'bash': return 'Bash'
    case 'read': return 'Read'
    case 'write': return 'Write'
    case 'edit': return 'Edit'
    case 'search': return 'Search'
    case 'todo': return 'TodoList'
    case 'agent': return 'Agent'
    case 'web': return 'Web'
    default: return call.toolName || 'Tool'
  }
}

/** 把顺序工具调用切分成连续同类段，用于分组折叠。 */
function splitRuns(calls: ToolCallInfo[]): Run[] {
  const runs: Run[] = []
  for (const call of calls) {
    const key = runKeyOf(call)
    const last = runs.at(-1)
    if (last !== undefined && last.key === key) {
      last.calls.push(call)
    } else {
      runs.push({ key, title: displayTitle(key, call), calls: [call] })
    }
  }
  return runs
}

function ToolCallGroup({ calls, title }: { calls: ToolCallInfo[]; title: string }) {
  const [expanded, setExpanded] = useState(false)
  const [userOverride, setUserOverride] = useState(false)

  const hasActive = calls.some((c) => c.status === 'running' || c.status === 'pending')
  const hasFailed = calls.some((c) => c.status === 'failed')

  // 进行中自动展开让进度可见；全部结束自动收起。用户手动切换后尊重用户选择。
  useEffect(() => {
    if (!userOverride) setExpanded(hasActive)
  }, [hasActive, userOverride])

  const lastSummary = useMemo(() => {
    const last = calls.at(-1)
    return last ? summarizeToolArgs(last.toolName, last.args) : undefined
  }, [calls])

  const totalMs = useMemo(() => {
    const durations = calls
      .filter((c) => c.startedAt !== undefined && c.endedAt !== undefined)
      .map((c) => (c.endedAt as number) - (c.startedAt as number))
    if (durations.length !== calls.length) return null
    return durations.reduce((sum, d) => sum + d, 0)
  }, [calls])
  const durationLabel =
    totalMs !== null ? (totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`) : null

  return (
    <div>
      <button
        onClick={() => {
          setUserOverride(true)
          setExpanded(!expanded)
        }}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left text-[12.5px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-[var(--lm-text-muted)] transition-transform" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--lm-text-muted)] transition-transform" />
        )}
        <span className="shrink-0 font-medium">{title}</span>
        <span className="shrink-0 rounded bg-[var(--lm-bg-hover)] px-1 font-mono text-[10.5px] text-[var(--lm-text-muted)]">
          ×{calls.length}
        </span>
        {lastSummary && (
          <span className="truncate font-mono text-[11.5px] text-[var(--lm-text-muted)]">· {lastSummary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {hasActive && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--lm-accent-text)]">
              <Loader2 size={12} className="lm-spin" />
              <span>运行中</span>
            </span>
          )}
          {!hasActive && hasFailed && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--lm-error)]">
              <XCircle size={13} />
              <span>部分失败</span>
            </span>
          )}
          {!hasActive && !hasFailed && (
            <span className="flex items-center text-[var(--lm-success)]">
              <CheckCircle2 size={13} />
            </span>
          )}
          {durationLabel && (
            <span className="font-mono text-[10.5px] text-[var(--lm-text-muted)]/70">{durationLabel}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-[var(--lm-border)] pl-1">
          {calls.map((call) => (
            <ToolCallBlock key={call.id} toolCall={call} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCallList({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const runs = useMemo(() => splitRuns(toolCalls), [toolCalls])
  return (
    <>
      {runs.map((run) => {
        const first = run.calls[0]
        if (first === undefined) return null
        return run.calls.length >= GROUP_THRESHOLD ? (
          <ToolCallGroup key={first.id} calls={run.calls} title={run.title} />
        ) : (
          run.calls.map((call) => <ToolCallBlock key={call.id} toolCall={call} />)
        )
      })}
    </>
  )
}
