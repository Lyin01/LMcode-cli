/**
 * Transcript size past which the list switches to a windowed render. Kept
 * high on purpose: the estimated-height windowing is only a safety valve for
 * pathological transcripts — measured row heights in real sessions vary from
 * a few pixels (collapsed tool rows) to many hundreds, and any sliding window
 * built on estimates drifts (the viewport jumps/flickers). Below this size
 * the whole transcript mounts and scrolling is plain native behavior.
 */
export const MESSAGE_LIST_VIRTUALIZE_AFTER = 1500
export const MESSAGE_LIST_ESTIMATED_ROW_PX = 180
export const MESSAGE_LIST_OVERSCAN = 6
/** Rows mounted beyond the viewport so scrolling stays ahead of rendering. */
export const MESSAGE_LIST_OVERSCAN_PX = 900

export interface MessageListWindowRange {
  readonly start: number
  readonly end: number
}

export interface MessageListWindowInput {
  readonly messageCount: number
  readonly findOpen: boolean
  readonly stickToBottom: boolean
  readonly windowRange: MessageListWindowRange
  readonly virtualizeAfter?: number
}

export interface MessageListWindow {
  readonly virtualize: boolean
  readonly start: number
  readonly end: number
}

/**
 * Choose which transcript rows to mount.
 *
 * Estimated-height windows based on scrollTop miss the newest messages
 * while the view is following the stream: the default range is `[0, 60)`,
 * so message 60+ is replaced by a bottom spacer and the streaming bubble
 * never mounts. When stuck to the bottom, pin the window to the tail.
 */
export function computeMessageListWindow(input: MessageListWindowInput): MessageListWindow {
  const virtualizeAfter = input.virtualizeAfter ?? MESSAGE_LIST_VIRTUALIZE_AFTER
  const virtualize = !input.findOpen && input.messageCount > virtualizeAfter
  if (!virtualize) {
    return { virtualize: false, start: 0, end: input.messageCount }
  }

  if (input.stickToBottom) {
    const span = Math.max(virtualizeAfter, input.windowRange.end - input.windowRange.start)
    const start = Math.max(0, input.messageCount - span)
    return { virtualize: true, start, end: input.messageCount }
  }

  const lastIndex = Math.max(0, input.messageCount - 1)
  const start = Math.min(Math.max(0, input.windowRange.start), lastIndex)
  const end = Math.min(input.messageCount, Math.max(start + 1, input.windowRange.end))
  return { virtualize: true, start, end }
}

/** Looks up the measured height (px) for a transcript row, if it was measured. */
export type MessageRowHeightLookup = (index: number) => number | undefined

function rowHeight(
  index: number,
  getHeight: MessageRowHeightLookup,
  estimatedRowPx: number,
): number {
  const measured = getHeight(index)
  return measured !== undefined && measured > 0 ? measured : estimatedRowPx
}

/**
 * Total height of rows `[from, to)` using measured heights where available and
 * the estimate elsewhere. The spacer heights must use the same lookup as
 * `rangeFromOffset`, otherwise sliding the window would change the scroll
 * height and make the viewport jump.
 */
export function sumMessageHeights(
  from: number,
  to: number,
  messageCount: number,
  getHeight: MessageRowHeightLookup,
  estimatedRowPx: number = MESSAGE_LIST_ESTIMATED_ROW_PX,
): number {
  let total = 0
  const first = Math.max(0, from)
  const last = Math.min(to, messageCount)
  for (let index = first; index < last; index++) {
    total += rowHeight(index, getHeight, estimatedRowPx)
  }
  return total
}

/**
 * Choose the mounted window for a scroll offset measured in *content* space.
 *
 * Unlike `floor(scrollTop / estimatedRowPx)` this walks the measured heights,
 * so a transcript whose rows are much taller or shorter than the estimate
 * still maps a scroll position to the rows actually visible there. The window
 * covers the viewport plus `overscanPx` on both sides.
 */
export function rangeFromOffset(input: {
  readonly messageCount: number
  readonly offsetPx: number
  readonly viewportPx: number
  readonly getHeight: MessageRowHeightLookup
  readonly estimatedRowPx?: number
  readonly overscanPx?: number
}): MessageListWindowRange {
  const count = Math.max(0, input.messageCount)
  if (count === 0) return { start: 0, end: 0 }
  const estimatedRowPx = input.estimatedRowPx ?? MESSAGE_LIST_ESTIMATED_ROW_PX
  const overscanPx = input.overscanPx ?? MESSAGE_LIST_OVERSCAN_PX
  const lower = Math.max(0, input.offsetPx - overscanPx)
  const upper = Math.max(
    lower + 1,
    input.offsetPx + Math.max(0, input.viewportPx) + overscanPx,
  )

  let accumulated = 0
  let start = -1
  let end = count
  for (let index = 0; index < count; index++) {
    const next = accumulated + rowHeight(index, input.getHeight, estimatedRowPx)
    if (start === -1 && next > lower) start = index
    if (next >= upper) {
      end = index + 1
      break
    }
    accumulated = next
  }
  if (start === -1) start = count - 1
  if (end <= start) end = Math.min(count, start + 1)
  return { start, end }
}
