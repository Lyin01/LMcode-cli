export const MESSAGE_LIST_VIRTUALIZE_AFTER = 60
export const MESSAGE_LIST_ESTIMATED_ROW_PX = 180
export const MESSAGE_LIST_OVERSCAN = 6

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
