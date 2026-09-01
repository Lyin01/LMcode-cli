import { describe, expect, it } from 'vitest'
import {
  computeMessageListWindow,
  MESSAGE_LIST_VIRTUALIZE_AFTER,
} from '../src/renderer/lib/message-list-window'

describe('computeMessageListWindow', () => {
  it('does not virtualize short transcripts', () => {
    const window = computeMessageListWindow({
      messageCount: 12,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 12 })
  })

  it('pins the window to the tail while stuck to the bottom', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window.virtualize).toBe(true)
    expect(window.end).toBe(90)
    expect(window.start).toBe(90 - MESSAGE_LIST_VIRTUALIZE_AFTER)
  })

  it('keeps the estimated scroll window when the user has scrolled up', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: false,
      stickToBottom: false,
      windowRange: { start: 10, end: 40 },
    })
    expect(window).toEqual({ virtualize: true, start: 10, end: 40 })
  })

  it('disables virtualization while find is open so matches stay mounted', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: true,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 90 })
  })

  it('clamps a scrolled window that overshoots the transcript', () => {
    const window = computeMessageListWindow({
      messageCount: 80,
      findOpen: false,
      stickToBottom: false,
      windowRange: { start: 70, end: 120 },
    })
    expect(window).toEqual({ virtualize: true, start: 70, end: 80 })
  })
})
