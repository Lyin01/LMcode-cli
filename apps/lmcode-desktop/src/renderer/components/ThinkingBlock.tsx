import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Sparkles, Copy, Check } from 'lucide-react'

interface ThinkingBlockProps {
  content: string
  state?: 'streaming' | 'complete' | 'hidden'
}

export function ThinkingBlock({ content, state = 'complete' }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(state === 'streaming')
  const [copied, setCopied] = useState(false)

  const charCount = useMemo(() => {
    return Array.from(content || '').length
  }, [content])

  if (state === 'hidden') return null

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const formatChars = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return String(n)
  }

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[12px] shadow-sm transition-all duration-200 hover:border-[var(--lm-border-hover)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:text-[var(--lm-text-primary)]"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-[var(--lm-text-muted)] transition-transform duration-150" />
        ) : (
          <ChevronRight size={13} className="text-[var(--lm-text-muted)] transition-transform duration-150" />
        )}
        <Sparkles size={12} className="text-[var(--lm-accent-text)]" />
        <span className="font-medium">思考过程</span>

        {charCount > 0 && (
          <span className="text-[11px] font-mono text-[var(--lm-text-muted)]">
            ({formatChars(charCount)} 字)
          </span>
        )}

        {state === 'streaming' ? (
          <span className="lm-pulse ml-auto flex items-center gap-1.5 text-[11px] font-medium text-[var(--lm-accent-text)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--lm-accent)]" />
            思考中…
          </span>
        ) : (
          <button
            onClick={handleCopy}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="复制思考内容"
          >
            {copied ? <Check size={11} className="text-[var(--lm-success)]" /> : <Copy size={11} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--lm-border)] bg-[var(--lm-bg-base)]/40 px-3 py-2.5">
          <p
            className={cn(
              'whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--lm-text-secondary)] select-text selection:bg-[var(--lm-accent)]/20',
              state === 'streaming' && 'typing-cursor',
            )}
          >
            {content}
          </p>
        </div>
      )}
    </div>
  )
}
