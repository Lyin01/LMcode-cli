import { describe, expect, it } from 'vitest'
import {
  MESSAGE_LIST_ESTIMATED_ROW_PX,
  MESSAGE_LIST_OVERSCAN_PX,
  rangeFromOffset,
  sumMessageHeights,
} from '../src/renderer/lib/message-list-window'

function lookup(heights: ReadonlyArray<number | undefined>) {
  return (index: number): number | undefined => heights[index]
}

describe('sumMessageHeights', () => {
  it('uses measured heights and falls back to the estimate for unmeasured rows', () => {
    const heights = [200, undefined, 300]
    expect(sumMessageHeights(0, 3, 3, lookup(heights), 100)).toBe(600)
  })

  it('ignores out-of-range indices', () => {
    const heights = [200, 300]
    expect(sumMessageHeights(-5, 99, 2, lookup(heights), 100)).toBe(500)
  })

  it('treats non-positive measurements as unmeasured', () => {
    const heights = [0, 50]
    expect(sumMessageHeights(0, 2, 2, lookup(heights), 100)).toBe(150)
  })
})

describe('rangeFromOffset', () => {
  it('falls back to estimates for a never-measured transcript', () => {
    const range = rangeFromOffset({
      messageCount: 10,
      offsetPx: 0,
      viewportPx: 300,
      getHeight: lookup([]),
      estimatedRowPx: 100,
      overscanPx: 0,
    })
    expect(range).toEqual({ start: 0, end: 3 })
  })

  it('walks measured heights so a tall first row does not skew the window', () => {
    const range = rangeFromOffset({
      messageCount: 4,
      offsetPx: 450,
      viewportPx: 100,
      getHeight: lookup([500, 50, 50, 50]),
      estimatedRowPx: 100,
      overscanPx: 0,
    })
    expect(range).toEqual({ start: 0, end: 2 })
  })

  it('extends the window upward by the pixel overscan', () => {
    const heights = [300, 100, 100, 100, 100]
    const tight = rangeFromOffset({
      messageCount: 5,
      offsetPx: 350,
      viewportPx: 100,
      getHeight: lookup(heights),
      estimatedRowPx: 100,
      overscanPx: 0,
    })
    expect(tight).toEqual({ start: 1, end: 3 })

    const loose = rangeFromOffset({
      messageCount: 5,
      offsetPx: 350,
      viewportPx: 100,
      getHeight: lookup(heights),
      estimatedRowPx: 100,
      overscanPx: 100,
    })
    expect(loose).toEqual({ start: 0, end: 4 })
  })

  it('clamps an offset past the transcript end to the last row', () => {
    const range = rangeFromOffset({
      messageCount: 5,
      offsetPx: 100_000,
      viewportPx: 100,
      getHeight: lookup([]),
    })
    expect(range).toEqual({ start: 4, end: 5 })
  })

  it('handles an empty transcript', () => {
    expect(
      rangeFromOffset({
        messageCount: 0,
        offsetPx: 0,
        viewportPx: 500,
        getHeight: lookup([]),
      }),
    ).toEqual({ start: 0, end: 0 })
  })

  it('always returns at least one row when messages exist', () => {
    const range = rangeFromOffset({
      messageCount: 1,
      offsetPx: 0,
      viewportPx: 500,
      getHeight: lookup([]),
    })
    expect(range).toEqual({ start: 0, end: 1 })
  })

  it('uses defaults matching the shared constants', () => {
    const range = rangeFromOffset({
      messageCount: 100,
      offsetPx: 0,
      viewportPx: MESSAGE_LIST_ESTIMATED_ROW_PX,
      getHeight: lookup([]),
    })
    // Visible row + overscan on both sides at minimum.
    expect(range.start).toBe(0)
    expect(range.end).toBeGreaterThanOrEqual(2)
    expect(sumMessageHeights(range.start, range.end, 100, lookup([]))).toBeGreaterThan(
      MESSAGE_LIST_OVERSCAN_PX,
    )
  })

  it('keeps the total height stable when the window slides (measured rows)', () => {
    // Every row measured: sliding the mounted window must not change the sum
    // of (top spacer + mounted rows + bottom spacer) — the invariant that
    // stops the viewport from jumping while wheeling through history.
    const heights = Array.from({ length: 80 }, (_, index) => 60 + (index % 7) * 90)
    const getHeight = lookup(heights)
    const total = sumMessageHeights(0, heights.length, heights.length, getHeight)
    for (const offset of [0, 500, 4000, 9000, 30_000]) {
      const range = rangeFromOffset({
        messageCount: heights.length,
        offsetPx: offset,
        viewportPx: 650,
        getHeight,
      })
      const top = sumMessageHeights(0, range.start, heights.length, getHeight)
      const mounted = sumMessageHeights(range.start, range.end, heights.length, getHeight)
      const bottom = sumMessageHeights(range.end, heights.length, heights.length, getHeight)
      expect(top + mounted + bottom).toBe(total)
    }
  })
})
