import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ToolCallInfo } from '@/types'
import { pruneToolOutput, formatCharCount } from '@/lib/tool-pruner'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
  Copy,
  Check,
  Maximize2,
  Minimize2,
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
  const [showFullResult, setShowFullResult] = useState(false)
  const [copied, setCopied] = useState(false)

  const pruneInfo = useMemo(() => {
    return pruneToolOutput(toolCall.result)
  }, [toolCall.result])

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    const contentToCopy = toolCall.result ?? ''
    void navigator.clipboard.writeText(contentToCopy)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const resultText = showFullResult ? pruneInfo.rawContent : pruneInfo.displayContent

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[12px] shadow-sm transition-all duration-200 hover:border-[var(--lm-border-hover)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-[var(--lm-text-muted)] transition-transform duration-150" />
        ) : (
          <ChevronRight size={13} className="text-[var(--lm-text-muted)] transition-transform duration-150" />
        )}
        <Wrench size={12} className="text-[var(--lm-text-muted)]" />
        <span className="font-medium text-[var(--lm-text-primary)]">{toolCall.toolName}</span>

        {pruneInfo.isPruned && (
          <span className="rounded bg-[var(--lm-bg-code)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--lm-text-muted)]">
            {formatCharCount(pruneInfo.totalChars)} · {pruneInfo.totalLines} 行
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <Icon size={13} className={cn(cfg.color, toolCall.status === 'running' && 'lm-spin')} />
          <span className={cn('text-[11px] font-medium', cfg.color)}>{cfg.label}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--lm-border)] bg-[var(--lm-bg-base)]/50">
          {toolCall.args && (
            <div className="border-b border-[var(--lm-border)] px-3 py-2">
              <div className="mb-1 text-[11px] font-medium text-[var(--lm-text-muted)]">参数</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--lm-bg-code)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--lm-text-secondary)]">
                {toolCall.args}
              </pre>
            </div>
          )}

          {toolCall.result && (
            <div className="px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--lm-text-muted)]">
                  <span>执行结果</span>
                  {pruneInfo.isPruned && (
                    <span className="text-[10px] text-[var(--lm-accent-text)]">
                      {showFullResult ? '(已展示全部)' : `(已精简 ${formatCharCount(pruneInfo.prunedChars)})`}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {pruneInfo.isPruned && (
                    <button
                      onClick={() => setShowFullResult(!showFullResult)}
                      className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                      title={showFullResult ? '切换为精简视图' : '展开完整输出'}
                    >
                      {showFullResult ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
                      <span>{showFullResult ? '精简' : '完整'}</span>
                    </button>
                  )}

                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                    title="复制完整结果"
                  >
                    {copied ? <Check size={11} className="text-[var(--lm-success)]" /> : <Copy size={11} />}
                    <span>{copied ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>

              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--lm-bg-code)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--lm-text-secondary)] selection:bg-[var(--lm-accent)]/20">
                {resultText}
              </pre>
            </div>
          )}
        </div>
      )}

      {toolCall.progress && toolCall.status === 'running' && (
        <div className="border-t border-[var(--lm-border)] bg-[var(--lm-bg-hover)]/30 px-3 py-1.5">
          <span className="animate-pulse text-[11px] text-[var(--lm-text-muted)]">{toolCall.progress}</span>
        </div>
      )}
    </div>
  )
}
