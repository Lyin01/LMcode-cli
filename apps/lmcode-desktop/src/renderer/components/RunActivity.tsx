import { Brain, CheckCircle2, Eye, Loader2, MessageCircle, RefreshCw, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { thinkingShortLabel } from '@/lib/thinking'
import { deriveRunStatus, formatRunElapsed, type RunPhase } from '@/lib/run-status'

const PHASE_ICONS: Record<RunPhase, typeof Brain> = {
  thinking: Brain,
  tool: Wrench,
  reviewing: Eye,
  responding: MessageCircle,
  retrying: RefreshCw,
  finishing: CheckCircle2,
}

export function RunActivity() {
  const messages = useSessionStore((state) => state.messages)
  const isStreaming = useSessionStore((state) => state.isStreaming)
  const streamStatus = useSessionStore((state) => state.streamStatus)
  const thinkingEffort = useSessionStore((state) => state.thinkingLevel)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isStreaming) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming])

  const status = useMemo(
    () =>
      deriveRunStatus({
        messages,
        isStreaming,
        streamStatus,
        thinkingEffort,
        now,
      }),
    [isStreaming, messages, now, streamStatus, thinkingEffort],
  )

  if (status === null) return null

  const Icon = PHASE_ICONS[status.phase]
  const isActive = status.phase !== 'finishing'

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex min-h-7 items-center gap-2 border-l-2 border-[var(--lm-accent)]/55 px-2 text-[11px] text-[var(--lm-text-muted)]"
    >
      <Icon
        size={13}
        className={isActive ? 'shrink-0 text-[var(--lm-accent-text)]' : 'shrink-0 text-[var(--lm-success)]'}
      />
      <span className="font-medium text-[var(--lm-text-secondary)]">{status.label}</span>
      {status.review !== undefined && (
        <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--lm-accent-text)]">
          {status.review.current}/{status.review.total}
        </span>
      )}
      <span className="font-mono text-[10px] text-[var(--lm-text-muted)]">
        {formatRunElapsed(status.elapsedMs)}
      </span>
      <span className="hidden items-center gap-1 sm:inline-flex">
        <span className="h-1 w-1 rounded-full bg-[var(--lm-border-strong)]" />
        {thinkingShortLabel(thinkingEffort)} 思考
      </span>
      {status.detail !== undefined && (
        <span className="min-w-0 truncate text-[10px] text-[var(--lm-text-muted)]">{status.detail}</span>
      )}
      {isActive && <Loader2 size={12} className="ml-auto shrink-0 text-[var(--lm-text-muted)] lm-spin" />}
    </div>
  )
}
