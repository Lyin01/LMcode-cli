import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { MessageItem } from '@/components/MessageItem'
import { findConversationMessageIds } from '@/lib/conversation-search'
import { historyToMessages } from '@/lib/history'
import {
  MESSAGE_LIST_ESTIMATED_ROW_PX,
  MESSAGE_LIST_VIRTUALIZE_AFTER,
  computeMessageListWindow,
  rangeFromOffset,
  sumMessageHeights,
} from '@/lib/message-list-window'
import { cn } from '@/lib/utils'
import type { ConversationFindRequest } from '@/lib/menu-command'
import { isImeConfirmKey } from '@/lib/ime'

/**
 * Distance from the bottom (px) within which the view follows new content
 * again. Kept tiny: while streaming, a larger threshold would drag the reader
 * back down on the next delta, which is exactly the "scrolling up bounces
 * back" bug. Upward wheel intent detaches even without reaching this.
 */
const STICK_THRESHOLD_PX = 2

interface ScrollAnchor {
  readonly id: string
  /** Anchor row position in *content* space (scrollTop + offset in viewport). */
  readonly contentOffset: number
}

/**
 * Manual scroll anchoring: pick the topmost visible row and remember where it
 * sits in the scroll content. After any commit that re-lays the list out
 * (window slide, row measurement, spacer change) the anchor is restored so
 * the content under the reader does not move.
 */
function captureScrollAnchor(
  container: HTMLElement,
  rows: ReadonlyMap<string, HTMLElement>,
): ScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top
  let bestId: string | null = null
  let bestTop = Number.POSITIVE_INFINITY
  for (const [id, node] of rows) {
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= containerTop + 0.5) continue
    if (rect.top < bestTop) {
      bestTop = rect.top
      bestId = id
    }
  }
  if (bestId === null) return null
  return { id: bestId, contentOffset: container.scrollTop + (bestTop - containerTop) }
}

interface MessageListProps {
  findRequest: ConversationFindRequest | null
}

export function MessageList({ findRequest }: MessageListProps) {
  const messages = useSessionStore((s) => s.messages)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const currentWorkDir = useSessionStore((s) =>
    s.sessions.find((session) => session.id === s.currentSessionId)?.workDir,
  )
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const setMessagesForSession = useSessionStore((s) => s.setMessagesForSession)
  const addMessageToSession = useSessionStore((s) => s.addMessageToSession)
  const enqueueMessage = useSessionStore((s) => s.enqueueMessage)
  const scrollRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const rowObserverRef = useRef<ResizeObserver | null>(null)
  const heightsFrameRef = useRef<number | null>(null)
  // Measured row heights by message id (ResizeObserver-fed). Spacers and the
  // mounted window both derive from this map, so sliding the window never
  // changes the total scroll height — the old estimate-only spacers made the
  // viewport jump ("flicker") whenever the fixed 180px guess disagreed with
  // the real row heights.
  const rowHeightsRef = useRef(new Map<string, number>())
  // Rolling average of measured heights, used as the estimate for rows that
  // were never mounted. A fixed 180px guess is bad on both ends (tiny tool
  // rows and huge output cards); the running average keeps spacer sums close
  // to reality so sliding the window does not shift the scroll height.
  const estimateRef = useRef(MESSAGE_LIST_ESTIMATED_ROW_PX)
  const lastScrollTopRef = useRef(0)
  const messagesRef = useRef(messages)
  // Latest captured scroll anchor (see captureScrollAnchor).
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const handledFindRequestRef = useRef(0)
  // Whether the view should keep following new content. Updated on scroll and
  // read by the messages effect — a ref, not state, so scrolling itself never
  // triggers a re-render.
  const stickToBottomRef = useRef(true)
  const sessionIdForStickRef = useRef(currentSessionId)
  const lastUserStickIdRef = useRef<string | undefined>(undefined)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [windowRange, setWindowRange] = useState({
    start: 0,
    end: MESSAGE_LIST_VIRTUALIZE_AFTER,
  })
  const [rowHeightsVersion, setRowHeightsVersion] = useState(0)
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

  const getRowHeight = useCallback((index: number): number | undefined => {
    const message = messagesRef.current[index]
    return message === undefined ? undefined : rowHeightsRef.current.get(message.id)
  }, [])

  const updateWindow = useCallback(() => {
    const el = scrollRef.current
    if (el === null) return
    const next = rangeFromOffset({
      messageCount: messagesRef.current.length,
      offsetPx: el.scrollTop,
      viewportPx: el.clientHeight,
      getHeight: getRowHeight,
      estimatedRowPx: estimateRef.current,
    })
    setWindowRange((current) => {
      if (current.start === next.start && current.end === next.end) return current
      return next
    })
  }, [getRowHeight])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (el === null) return
    const scrolledDown = el.scrollTop > lastScrollTopRef.current + 0.5
    lastScrollTopRef.current = el.scrollTop
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    // Re-stick only when the user is actually heading to the bottom. A layout
    // change (row measurement, window slide) can clamp scrollTop and leave the
    // view a pixel from the bottom without any user intent — that must not
    // hijack the scroll position back down (the "bounces back" bug).
    const nextStick = atBottom && (stickToBottomRef.current || scrolledDown)
    stickToBottomRef.current = nextStick
    setShowJumpToBottom(!stickToBottomRef.current)
    updateWindow()
  }, [updateWindow])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = true
    setShowJumpToBottom(false)
    el.scrollTop = el.scrollHeight
  }, [])

  // Upward wheel intent detaches from the bottom immediately. Without this,
  // a reader inside the stick threshold gets snapped back by every streaming
  // delta until the wheel moves past the threshold.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0 || event.ctrlKey) return
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
      if (remaining <= 0) return
      stickToBottomRef.current = false
      setShowJumpToBottom(true)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Track real row heights (they vary wildly: a one-line bubble vs a bash
  // output card) so window math uses measured pixels instead of a fixed
  // guess. Measurements only update the cache; the anchor layout effect
  // below keeps the viewport stable when a measurement re-lays the list out.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const id = node.dataset['msgId']
        if (id === undefined) continue
        const height = node.offsetHeight
        if (rowHeightsRef.current.get(id) === height) continue
        rowHeightsRef.current.set(id, height)
        changed = true
      }
      if (!changed) return
      let sum = 0
      let count = 0
      for (const height of rowHeightsRef.current.values()) {
        sum += height
        count += 1
      }
      if (count > 0) {
        estimateRef.current = Math.min(480, Math.max(24, Math.round(sum / count)))
      }
      if (heightsFrameRef.current !== null) return
      heightsFrameRef.current = requestAnimationFrame(() => {
        heightsFrameRef.current = null
        setRowHeightsVersion((version) => version + 1)
      })
    })
    rowObserverRef.current = observer
    for (const node of messageRefs.current.values()) observer.observe(node)
    return () => {
      rowObserverRef.current = null
      observer.disconnect()
      if (heightsFrameRef.current !== null) {
        cancelAnimationFrame(heightsFrameRef.current)
        heightsFrameRef.current = null
      }
    }
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

  // ── Regenerate ────────────────────────────────────────────────────
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.role === 'assistant') return m.id
    }
    return null
  }, [messages])

  const lastUser = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.role === 'user') return m
    }
    return null
  }, [messages])
  const lastUserText = lastUser?.content ?? ''
  const lastUserAttachments = lastUser?.attachments
  const canRegenerate =
    Boolean(lastUser) &&
    (lastUserText.trim().length > 0 || (lastUserAttachments?.length ?? 0) > 0)

  // Session switches and a freshly sent user message must restick before
  // the window is computed. Doing this during render (not in an effect)
  // keeps the newest row mounted on the same frame it arrives. Only the
  // *new* user message resticks — a waiting transcript whose last row is
  // still the user message must remain scrollable.
  if (sessionIdForStickRef.current !== currentSessionId) {
    sessionIdForStickRef.current = currentSessionId
    stickToBottomRef.current = true
    lastUserStickIdRef.current = undefined
  }
  messagesRef.current = messages
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === 'user' && lastMessage.id !== lastUserStickIdRef.current) {
    lastUserStickIdRef.current = lastMessage.id
    stickToBottomRef.current = true
  }

  const listWindow = computeMessageListWindow({
    messageCount: messages.length,
    findOpen,
    stickToBottom: stickToBottomRef.current,
    windowRange,
  })
  const visibleMessages = listWindow.virtualize
    ? messages.slice(listWindow.start, listWindow.end)
    : messages
  const spacers = useMemo(
    () =>
      listWindow.virtualize
        ? {
            top: sumMessageHeights(
              0,
              listWindow.start,
              messages.length,
              getRowHeight,
              estimateRef.current,
            ),
            bottom: sumMessageHeights(
              listWindow.end,
              messages.length,
              messages.length,
              getRowHeight,
              estimateRef.current,
            ),
          }
        : { top: 0, bottom: 0 },
    // rowHeightsVersion: spacer heights change when a row was measured.
    [
      listWindow.virtualize,
      listWindow.start,
      listWindow.end,
      messages,
      getRowHeight,
      rowHeightsVersion,
    ],
  )
  const topSpacer = spacers.top
  const bottomSpacer = spacers.bottom

  // Keep the content under the reader fixed across window slides and row
  // measurements. With manual anchoring (and `overflow-anchor: none` on the
  // scroller) the browser does not apply its own anchoring on top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else {
      const anchor = anchorRef.current
      if (anchor !== null) {
        const node = messageRefs.current.get(anchor.id)
        if (node !== undefined) {
          const containerTop = el.getBoundingClientRect().top
          const contentOffset =
            el.scrollTop + (node.getBoundingClientRect().top - containerTop)
          const delta = contentOffset - anchor.contentOffset
          if (delta !== 0) el.scrollTop = Math.max(0, el.scrollTop + delta)
        }
      }
    }
    anchorRef.current = captureScrollAnchor(el, messageRefs.current)
  }, [listWindow.start, listWindow.end, rowHeightsVersion])

  const handleRegenerate = useCallback(async () => {
    if (!currentSessionId || isStreaming || !canRegenerate) return
    const text = lastUserText
    const attachments = lastUserAttachments ?? []
    const showError = (message: string): void => {
      addMessageToSession(currentSessionId, {
        id: `msg_regen_err_${Date.now()}`,
        role: 'system',
        variant: 'error',
        content: message,
        timestamp: Date.now(),
      })
    }
    try {
      // Undo the last assistant turn first. If the history refresh fails after
      // that, the turn is already gone — tell the user instead of leaving a
      // silent half-revoke.
      await window.lmcodeAPI.undoHistory(currentSessionId, 1)
    } catch (err) {
      console.error('Failed to regenerate:', err)
      showError(`重新生成失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    try {
      const history = await window.lmcodeAPI.getSessionHistory(currentSessionId)
      setMessagesForSession(currentSessionId, historyToMessages(history))
    } catch (err) {
      console.error('Failed to refresh history after regenerate undo:', err)
      showError(
        `已撤销上一轮，但刷新对话失败：${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    enqueueMessage(currentSessionId, text, attachments)
  }, [
    addMessageToSession,
    canRegenerate,
    currentSessionId,
    enqueueMessage,
    isStreaming,
    lastUserAttachments,
    lastUserText,
    setMessagesForSession,
  ])

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
                if (isImeConfirmKey(event)) return
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
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overflowAnchor: 'none' }}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-7">
          {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden />}
          {visibleMessages.map((msg) => (
            <div
              key={msg.id}
              data-msg-id={msg.id}
              ref={(node) => {
                const previous = messageRefs.current.get(msg.id)
                if (node !== null) {
                  messageRefs.current.set(msg.id, node)
                  if (previous !== node) rowObserverRef.current?.observe(node)
                } else {
                  messageRefs.current.delete(msg.id)
                  if (previous !== undefined) rowObserverRef.current?.unobserve(previous)
                }
              }}
              className={cn(
                'rounded-xl transition-[box-shadow,background-color] duration-150',
                matchingMessageIdSet.has(msg.id) &&
                  'bg-[var(--lm-accent-soft)]/35 ring-1 ring-[var(--lm-border-strong)]',
                activeMatchId === msg.id &&
                  'bg-[var(--lm-accent-soft)]/70 ring-2 ring-[var(--lm-accent)]',
              )}
            >
              <MessageItem
                message={msg}
                workDir={currentWorkDir}
                isStreaming={isStreaming && msg.id === lastAssistantId}
                onRegenerate={
                  msg.id === lastAssistantId && !isStreaming && canRegenerate
                    ? handleRegenerate
                    : undefined
                }
              />
            </div>
          ))}
          {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden />}
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
