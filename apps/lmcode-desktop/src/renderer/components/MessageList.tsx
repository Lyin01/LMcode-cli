import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { MessageItem } from '@/components/MessageItem'

/** Distance from the bottom (px) within which the view is considered "stuck". */
const STICK_THRESHOLD_PX = 80

export function MessageList() {
  const messages = useSessionStore((s) => s.messages)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the view should keep following new content. Updated on scroll and
  // read by the messages effect — a ref, not state, so scrolling itself never
  // triggers a re-render.
  const stickToBottomRef = useRef(true)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
    stickToBottomRef.current = atBottom
    if (atBottom) setShowJumpToBottom(false)
  }, [])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = true
    setShowJumpToBottom(false)
    el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // A freshly sent user message always re-sticks the view to the bottom.
    const last = messages[messages.length - 1]
    if (last?.role === 'user') stickToBottomRef.current = true
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else {
      // User scrolled up to read history — don't yank the view back down on
      // every streaming delta, just offer a way back.
      setShowJumpToBottom(true)
    }
  }, [messages])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-7">
          {messages.map((msg) => (
            <MessageItem key={msg.id} message={msg} />
          ))}
        </div>
      </div>
      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[var(--lm-text-secondary)] shadow-[var(--lm-shadow-soft)] transition-colors hover:text-[var(--lm-text-primary)]"
          title="回到底部"
          aria-label="回到底部"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  )
}
