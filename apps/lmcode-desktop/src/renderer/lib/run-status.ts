import type { Message, ToolCallInfo } from '@/types'
import type { ThinkingEffort } from '@/lib/thinking'

export type RunPhase =
  | 'thinking'
  | 'tool'
  | 'reviewing'
  | 'responding'
  | 'retrying'
  | 'finishing'

export interface RunStatus {
  readonly phase: RunPhase
  readonly label: string
  readonly detail?: string
  readonly elapsedMs: number
  readonly review?: { readonly current: number; readonly total: number }
}

const REVIEW_PROGRESS_RE = /^Automatic review (\d+)\/(\d+):\s*(.*)$/iu

/** Convert a running tool into the short verb shown in the activity rail. */
function toolLabel(tool: ToolCallInfo): string {
  const name = tool.toolName.toLowerCase()
  if (name === 'write' || name === 'edit' || name === 'multiedit') return '正在修改文件'
  if (name === 'read' || name === 'glob' || name === 'grep') return '正在读取项目'
  if (name === 'bash' || name === 'shell') return '正在运行命令'
  if (name === 'taskoutput') return '正在等待后台任务'
  if (name === 'agent' || name === 'wolfpack') return '正在协调子任务'
  return `正在运行 ${tool.toolName || '工具'}`
}

function reviewLabel(progress: string): string {
  const normalized = progress.toLowerCase()
  if (normalized.includes('rendered keyframes')) return '自动审查 · 渲染检查'
  if (normalized.includes('reviewing source')) return '自动审查 · 源码检查'
  return '自动审查 · 运行时检查'
}

function latestAssistant(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

function latestRunningTool(message: Message | undefined): ToolCallInfo | undefined {
  const calls = message?.toolCalls
  if (calls === undefined) return undefined
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call?.status === 'running' || call?.status === 'pending') return call
  }
  return undefined
}

function elapsedFrom(message: Message | undefined, now: number): number {
  if (message === undefined || !Number.isFinite(message.timestamp)) return 0
  return Math.max(0, now - message.timestamp)
}

export function formatRunElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Project the event-backed transcript into one stable, human-readable phase.
 * This keeps rendering independent from provider-specific event names while
 * still exposing the expensive post-write review stage clearly.
 */
export function deriveRunStatus(input: {
  readonly messages: readonly Message[]
  readonly isStreaming: boolean
  readonly streamStatus: string | null
  readonly thinkingEffort: ThinkingEffort
  readonly now?: number
}): RunStatus | null {
  if (!input.isStreaming) return null

  const assistant = latestAssistant(input.messages)
  const now = input.now ?? Date.now()
  const elapsedMs = elapsedFrom(assistant, now)

  if (input.streamStatus?.trim()) {
    return {
      phase: 'retrying',
      label: '正在重试',
      detail: input.streamStatus,
      elapsedMs,
    }
  }

  const runningTool = latestRunningTool(assistant)
  if (runningTool !== undefined) {
    const progress = runningTool.progress?.trim()
    if (progress !== undefined) {
      const match = REVIEW_PROGRESS_RE.exec(progress)
      if (match !== null) {
        const current = Number(match[1])
        const total = Number(match[2])
        if (Number.isSafeInteger(current) && Number.isSafeInteger(total)) {
          return {
            phase: 'reviewing',
            label: reviewLabel(progress),
            detail: match[3] || undefined,
            elapsedMs,
            review: { current, total },
          }
        }
      }
      return {
        phase: 'tool',
        label: toolLabel(runningTool),
        detail: progress,
        elapsedMs,
      }
    }
    return {
      phase: 'tool',
      label: toolLabel(runningTool),
      elapsedMs,
    }
  }

  if (assistant?.thinkingState === 'streaming') {
    return {
      phase: 'thinking',
      label: '正在思考',
      detail: `思考强度 · ${input.thinkingEffort}`,
      elapsedMs,
    }
  }

  if (assistant?.content.trim()) {
    return {
      phase: 'responding',
      label: '正在整理回答',
      elapsedMs,
    }
  }

  return {
    phase: 'thinking',
    label: '正在分析任务',
    elapsedMs,
  }
}
