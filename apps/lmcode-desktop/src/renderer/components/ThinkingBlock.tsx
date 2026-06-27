import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

interface ThinkingBlockProps {
  content: string
  state?: 'streaming' | 'complete' | 'hidden'
}

export function ThinkingBlock({ content, state = 'complete' }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(state === 'streaming')

  if (state === 'hidden') return null

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:text-[var(--lm-text-primary)]"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Sparkles size={12} className="text-[var(--lm-accent-text)]" />
        <span>思考过程</span>
        {state === 'streaming' && (
          <span className="lm-pulse ml-auto flex items-center gap-1.5 text-[var(--lm-text-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--lm-accent)]" />
            思考中
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-[var(--lm-border)] px-3 py-2.5">
          <p
            className={cn(
              'whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--lm-text-secondary)]',
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
