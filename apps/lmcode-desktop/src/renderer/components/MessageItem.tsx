import type { Message } from '@/types'
import { memo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { ToolCallBlock } from '@/components/ToolCallBlock'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Module-level constants: inline arrays would break React.memo's props
// comparison on every render.
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

interface MessageItemProps {
  message: Message
}

// memoized: during streaming only the last assistant message gets a new object
// identity (see patchLastAssistant), so historical items bail out of the
// expensive markdown + highlight.js re-render.
export const MessageItem = memo(function MessageItem({ message }: MessageItemProps) {
  const { role } = message

  // ── User: right-aligned warm bubble ────────────────────────────────
  if (role === 'user') {
    return (
      <div className="flex animate-fade-in justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-[18px] bg-[var(--lm-bg-bubble)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--lm-text-primary)]">
          {message.content}
        </div>
      </div>
    )
  }

  // ── System / tool notices ──────────────────────────────────────────
  if (role === 'system' || role === 'tool') {
    const isError = message.variant === 'error'
    return (
      <div className="flex animate-fade-in justify-center">
        <div
          className={
            isError
              ? 'flex items-center gap-2 rounded-lg border border-[var(--lm-error)]/40 bg-[var(--lm-error)]/10 px-3 py-2 text-[12px] text-[var(--lm-error)]'
              : 'rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[12px] text-[var(--lm-text-muted)]'
          }
        >
          {isError && <AlertTriangle size={13} className="shrink-0" />}
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      </div>
    )
  }

  // ── Assistant: avatar + flowing prose ──────────────────────────────
  return (
    <div className="flex animate-fade-in gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--lm-accent-soft)] text-[12px] font-bold text-[var(--lm-accent-text)]">
        L
      </div>

      <div className="min-w-0 flex-1">
        {message.thinking && (
          <ThinkingBlock content={message.thinking} state={message.thinkingState} />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2.5 space-y-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {message.content ? (
          <div className="lm-markdown">
            <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {message.content}
            </Markdown>
          </div>
        ) : message.thinkingState === 'streaming' ? (
          <span className="lm-pulse text-[13px] text-[var(--lm-text-muted)]">思考中…</span>
        ) : null}
      </div>
    </div>
  )
})
