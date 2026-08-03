import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { MessageItem } from '@/components/MessageItem'
import { findConversationMessageIds } from '@/lib/conversation-search'
import { cn } from '@/lib/utils'
import type { ConversationFindRequest } from '@/lib/menu-command'

/** Distance from the bottom (px) within which the view is considered "stuck". */
const STICK_THRESHOLD_PX = 80

interface MessageListProps {
  findRequest: ConversationFindRequest | null
}

export function MessageList({ findRequest }: MessageListProps) {
  const messages = useSessionStore((s) => s.messages)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const handledFindRequestRef = useRef(0)
  // Whether the view should keep following new content. Updated on scroll and
  // read by the messages effect — a ref, not state, so scrolling itself never
  // triggers a re-render.
  const stickToBottomRef = useRef(true)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const matchingMessageIds = useMemo(
    () => (findOpen ? findConversationMessageIds(messages, findQuery) : []),
    [findOpen, findQuery, messages],
  )
  const matchingMessageIdSet = useMemo(
    () => new Set(matchingMessageIds),
    [matchingMessageIds],
  )
  const activeMatchId = matchingMessageIds[activeMatchIndex] ?? null

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

  const moveMatch = useCallback(
    (direction: -1 | 1) => {
      if (matchingMessageIds.length === 0) {
        findInputRef.current?.focus()
        return
      }
      setActiveMatchIndex((current) =>
        (current + direction + matchingMessageIds.length) % matchingMessageIds.length,
      )
    },
    [matchingMessageIds.length],
  )

  const closeFind = useCallback(() => {
    setFindOpen(false)
  }, [])

  useEffect(() => {
    // Session switch replaces messages wholesale: re-stick to the bottom so a
    // scrolled-up position (and the jump button) never leaks into the new
    // session. Declared before the messages effect so it runs first.
    stickToBottomRef.current = true
    setShowJumpToBottom(false)
  }, [currentSessionId])

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

  useEffect(() => {
    setActiveMatchIndex(0)
  }, [findQuery])

  useEffect(() => {
    if (matchingMessageIds.length === 0) {
      setActiveMatchIndex(0)
      return
    }
    setActiveMatchIndex((current) => Math.min(current, matchingMessageIds.length - 1))
  }, [matchingMessageIds.length])

  useEffect(() => {
    if (activeMatchId === null) return
    messageRefs.current.get(activeMatchId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  }, [activeMatchId])

  useEffect(() => {
    if (
      findRequest === null ||
      handledFindRequestRef.current === findRequest.nonce
    ) return
    handledFindRequestRef.current = findRequest.nonce
    setFindOpen(true)

    if (findRequest.action === 'next') {
      moveMatch(1)
    } else if (findRequest.action === 'previous') {
      moveMatch(-1)
    }

    const animationFrame = requestAnimationFrame(() => {
      if (findRequest.action === 'open' || !findQuery.trim()) {
        findInputRef.current?.focus()
        findInputRef.current?.select()
      }
    })
    return () => cancelAnimationFrame(animationFrame)
  }, [findQuery, findRequest, moveMatch])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {findOpen && (
        <div className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] p-1.5 shadow-[var(--lm-shadow-soft)]">
          <Search size={14} className="ml-1 text-[var(--lm-text-muted)]" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                moveMatch(event.shiftKey ? -1 : 1)
              }
            }}
            className="w-52 bg-transparent px-1 py-1 text-[12px] text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)]"
            placeholder="在当前对话中查找"
            aria-label="在当前对话中查找"
          />
          <span className="min-w-12 text-center font-mono text-[10px] text-[var(--lm-text-muted)]">
            {matchingMessageIds.length > 0
              ? `${activeMatchIndex + 1} / ${matchingMessageIds.length}`
              : '0 / 0'}
          </span>
          <button
            onClick={() => moveMatch(-1)}
            disabled={matchingMessageIds.length === 0}
            className="rounded-md p-1 text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-35"
            title="上一个匹配项（Shift+Enter）"
            aria-label="上一个匹配项"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => moveMatch(1)}
            disabled={matchingMessageIds.length === 0}
            className="rounded-md p-1 text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-35"
            title="下一个匹配项（Enter）"
            aria-label="下一个匹配项"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={closeFind}
            className="rounded-md p-1 text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]"
            title="关闭查找（Esc）"
            aria-label="关闭查找"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-7">
          {messages.map((msg) => (
            <div
              key={msg.id}
              ref={(node) => {
                if (node) messageRefs.current.set(msg.id, node)
                else messageRefs.current.delete(msg.id)
              }}
              className={cn(
                'rounded-xl transition-[box-shadow,background-color] duration-150',
                matchingMessageIdSet.has(msg.id) &&
                  'bg-[var(--lm-accent-soft)]/35 ring-1 ring-[var(--lm-border-strong)]',
                activeMatchId === msg.id &&
                  'bg-[var(--lm-accent-soft)]/70 ring-2 ring-[var(--lm-accent)]',
              )}
            >
              <MessageItem message={msg} />
            </div>
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
