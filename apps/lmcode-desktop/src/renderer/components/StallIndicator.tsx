import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import {
  buildStallNotice,
  runningToolName,
  STALL_THRESHOLD_MS,
} from '@/lib/stream-stall'

/**
 * Heartbeat shown while a turn is active but no streaming event has arrived
 * for a while (long tool execution such as automatic post-write validation,
 * or a slow first token). Any store event resets the clock; the notice itself
 * re-renders once per second to keep the elapsed time honest.
 */
export function StallIndicator() {
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const messages = useSessionStore((s) => s.messages)
  const lastEventAtRef = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    lastEventAtRef.current = Date.now()
    setNow(Date.now())
  }, [messages, isStreaming])

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null
  const elapsedMs = now - lastEventAtRef.current
  if (elapsedMs < STALL_THRESHOLD_MS) return null

  return (
    <div
      role="status"
      className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] text-[var(--lm-text-muted)]"
    >
      <Loader2 size={11} className="lm-spin shrink-0" />
      <span>{buildStallNotice(runningToolName(messages), elapsedMs)}</span>
    </div>
  )
}
