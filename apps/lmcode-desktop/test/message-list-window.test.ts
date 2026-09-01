import { describe, expect, it } from 'vitest'
import {
  MESSAGE_LIST_VIRTUALIZE_AFTER,
  computeMessageListWindow,
} from '../src/renderer/lib/message-list-window'

describe('computeMessageListWindow', () => {
  it('mounts the full list below the virtualize threshold', () => {
    const window = computeMessageListWindow({
      messageCount: MESSAGE_LIST_VIRTUALIZE_AFTER,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window).toEqual({
      virtualize: false,
      start: 0,
      end: MESSAGE_LIST_VIRTUALIZE_AFTER,
    })
  })

  it('pins the window to the tail while following the stream', () => {
    const window = computeMessageListWindow({
      messageCount: 61,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window.virtualize).toBe(true)
    expect(window.start).toBe(1)
    expect(window.end).toBe(61)
  })

  it('keeps the newest message mounted for a long stuck transcript', () => {
    const window = computeMessageListWindow({
      messageCount: 200,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window.start).toBe(140)
    expect(window.end).toBe(200)
  })

  it('uses the scroll window when the user has scrolled up', () => {
    const window = computeMessageListWindow({
      messageCount: 200,
      findOpen: false,
      stickToBottom: false,
      windowRange: { start: 20, end: 40 },
    })
    expect(window).toEqual({ virtualize: true, start: 20, end: 40 })
  })

  it('disables virtualization while find is open so matches can mount', () => {
    const window = computeMessageListWindow({
      messageCount: 200,
      findOpen: true,
      stickToBottom: true,
      windowRange: { start: 0, end: 60 },
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 200 })
  })
})
