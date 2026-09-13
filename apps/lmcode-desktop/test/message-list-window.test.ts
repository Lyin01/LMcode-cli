import { describe, expect, it } from 'vitest'
import {
  computeMessageListWindow,
  MESSAGE_LIST_VIRTUALIZE_AFTER,
} from '../src/renderer/lib/message-list-window'

describe('computeMessageListWindow', () => {
  // The mechanism tests pin the threshold explicitly so they keep exercising
  // the windowed path; the production default is covered separately below.
  const windowed = { virtualizeAfter: 60 }

  it('does not virtualize short transcripts', () => {
    const window = computeMessageListWindow({
      messageCount: 12,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 12 })
  })

  it('mounts a typical long session in full under the default threshold', () => {
    // Sessions with hundreds of rows used to be windowed with estimated row
    // heights; real rows vary wildly, so the windowed path made the viewport
    // jump/flicker. It is now reserved for pathological transcripts only.
    const window = computeMessageListWindow({
      messageCount: 700,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: MESSAGE_LIST_VIRTUALIZE_AFTER },
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 700 })
    expect(MESSAGE_LIST_VIRTUALIZE_AFTER).toBeGreaterThanOrEqual(1000)
  })

  it('pins the window to the tail while stuck to the bottom', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: false,
      stickToBottom: true,
      windowRange: { start: 0, end: 60 },
      ...windowed,
    })
    expect(window.virtualize).toBe(true)
    expect(window.end).toBe(90)
    expect(window.start).toBe(90 - 60)
  })

  it('keeps the measured scroll window when the user has scrolled up', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: false,
      stickToBottom: false,
      windowRange: { start: 10, end: 40 },
      ...windowed,
    })
    expect(window).toEqual({ virtualize: true, start: 10, end: 40 })
  })

  it('disables virtualization while find is open so matches stay mounted', () => {
    const window = computeMessageListWindow({
      messageCount: 90,
      findOpen: true,
      stickToBottom: true,
      windowRange: { start: 0, end: 60 },
      ...windowed,
    })
    expect(window).toEqual({ virtualize: false, start: 0, end: 90 })
  })

  it('clamps a scrolled window that overshoots the transcript', () => {
    const window = computeMessageListWindow({
      messageCount: 80,
      findOpen: false,
      stickToBottom: false,
      windowRange: { start: 70, end: 120 },
      ...windowed,
    })
    expect(window).toEqual({ virtualize: true, start: 70, end: 80 })
  })
})
