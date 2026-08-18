import { Brain, Check, ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface ThinkingBlockProps {
  content?: string
  state?: 'streaming' | 'complete' | 'hidden'
}

export function ThinkingBlock({ content = '', state = 'complete' }: ThinkingBlockProps) {
  const previousState = useRef(state)
  const [expanded, setExpanded] = useState(state === 'streaming')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (state === 'streaming') {
      setExpanded(true)
    } else if (previousState.current === 'streaming') {
      setExpanded(false)
    }
    previousState.current = state
  }, [state])

  if (state === 'hidden') return null

  const charCount = Array.from(content).length
  const formatChars = (count: number): string =>
    count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard permissions are optional; the content remains selectable.
    }
  }

  const streaming = state === 'streaming'

  return (
    <section className="mb-3 border-l-2 border-[var(--lm-accent)]/45 pl-3" aria-label="思考过程">
      <div className="flex min-h-7 items-center gap-1.5 text-[12px]">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {streaming ? (
            <Loader2 size={13} className="shrink-0 text-[var(--lm-accent-text)] lm-spin" />
          ) : (
            <Brain size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
          )}
          <span className="font-medium">{streaming ? '正在思考' : '思考完成'}</span>
          {charCount > 0 && (
            <span className="font-mono text-[10px] text-[var(--lm-text-muted)]">
              {formatChars(charCount)} 字
            </span>
          )}
        </button>

        <span className="ml-auto flex items-center gap-1.5">
          {streaming && <span className="text-[10px] text-[var(--lm-accent-text)]">实时</span>}
          {!streaming && (
            <button
              type="button"
              onClick={() => void handleCopy()}
              title="复制思考内容"
              aria-label="复制思考内容"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            >
              {copied ? <Check size={12} className="text-[var(--lm-success)]" /> : <Copy size={12} />}
            </button>
          )}
        </span>
      </div>

      {expanded && (
        <div className="mt-1 max-h-72 overflow-y-auto pr-2">
          <p
            className={cn(
              'whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--lm-text-secondary)] select-text selection:bg-[var(--lm-accent)]/20',
              streaming && 'typing-cursor',
            )}
          >
            {content || (streaming ? '正在组织思路…' : '没有可显示的思考内容。')}
          </p>
        </div>
      )}
    </section>
  )
}
