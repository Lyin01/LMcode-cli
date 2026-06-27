import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ToolCallInfo } from '@/types'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
} from 'lucide-react'

interface ToolCallBlockProps {
  toolCall: ToolCallInfo
}

const statusConfig = {
  pending: { icon: Clock, color: 'text-[var(--lm-text-muted)]', label: '等待中' },
  running: { icon: Loader2, color: 'text-[var(--lm-accent-text)]', label: '运行中' },
  completed: { icon: CheckCircle2, color: 'text-[var(--lm-success)]', label: '已完成' },
  failed: { icon: XCircle, color: 'text-[var(--lm-error)]', label: '失败' },
} as const

export function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const cfg = statusConfig[toolCall.status]
  const Icon = cfg.icon
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[12px]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-[var(--lm-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="text-[var(--lm-text-muted)]" />
        )}
        <Wrench size={12} className="text-[var(--lm-text-muted)]" />
        <span className="font-medium text-[var(--lm-text-primary)]">{toolCall.toolName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Icon size={13} className={cn(cfg.color, toolCall.status === 'running' && 'lm-spin')} />
          <span className={cn('text-[11px]', cfg.color)}>{cfg.label}</span>
        </span>
      </button>

      {expanded && (
        <>
          <div className="border-t border-[var(--lm-border)] px-3 py-2">
            <div className="mb-1 text-[11px] text-[var(--lm-text-muted)]">参数</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--lm-bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
              {toolCall.args}
            </pre>
          </div>

          {toolCall.result && (
            <div className="border-t border-[var(--lm-border)] px-3 py-2">
              <div className="mb-1 text-[11px] text-[var(--lm-text-muted)]">结果</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--lm-bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
                {toolCall.result}
              </pre>
            </div>
          )}
        </>
      )}

      {toolCall.progress && toolCall.status === 'running' && (
        <div className="border-t border-[var(--lm-border)] px-3 py-1.5">
          <span className="text-[11px] text-[var(--lm-text-muted)]">{toolCall.progress}</span>
        </div>
      )}
    </div>
  )
}
