import { describe, it, expect, beforeEach } from 'vitest'
import {
  pruneToolOutput,
  pruneToolOutputCached,
  clearPruneCache,
  codePointLength,
  formatCharCount,
} from '../src/renderer/lib/tool-pruner'

describe('tool-pruner', () => {
  beforeEach(() => {
    clearPruneCache()
  })
  it('measures Unicode code points accurately', () => {
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength('你好世界')).toBe(4)
    expect(codePointLength('🚀🔥🎉')).toBe(3)
  })

  it('formats character counts cleanly', () => {
    expect(formatCharCount(500)).toBe('500 字符')
    expect(formatCharCount(5000)).toBe('5.0k 字符')
    expect(formatCharCount(2_500_000)).toBe('2.5M 字符')
  })

  it('does not prune outputs under threshold', () => {
    const text = 'Short output line 1\nLine 2'
    const result = pruneToolOutput(text, { thresholdChars: 100 })
    expect(result.isPruned).toBe(false)
    expect(result.displayContent).toBe(text)
    expect(result.totalChars).toBe(text.length)
    expect(result.prunedChars).toBe(0)
    expect(result.totalLines).toBe(2)
  })

  it('safely handles empty or null outputs', () => {
    const emptyResult = pruneToolOutput('')
    expect(emptyResult.isPruned).toBe(false)
    expect(emptyResult.displayContent).toBe('')

    const nullResult = pruneToolOutput(null as unknown as string)
    expect(nullResult.isPruned).toBe(false)
    expect(nullResult.displayContent).toBe('')
  })

  it('skips pruning when UTF-16 length is already under the threshold', () => {
    const text = `${'A'.repeat(100)}\n${'B'.repeat(50)}`
    const result = pruneToolOutput(text, { thresholdChars: 200 })
    expect(result.isPruned).toBe(false)
    expect(result.displayContent).toBe(text)
    expect(result.totalChars).toBe(text.length)
    expect(result.totalLines).toBe(2)
  })

  it('still counts code points when UTF-16 length is over budget but glyphs are not', () => {
    const text = '🚀'.repeat(40)
    const result = pruneToolOutput(text, { thresholdChars: 50 })
    expect(text.length).toBe(80)
    expect(result.isPruned).toBe(false)
    expect(result.totalChars).toBe(40)
    expect(result.displayContent).toBe(text)
  })

  it('prunes over-budget outputs preserving head and tail', () => {
    const head = 'H'.repeat(20)
    const middle = 'M'.repeat(100)
    const tail = 'T'.repeat(20)
    const raw = head + middle + tail // total 140 chars

    const result = pruneToolOutput(raw, {
      thresholdChars: 50,
      headChars: 20,
      tailChars: 20,
    })

    expect(result.isPruned).toBe(true)
    expect(result.totalChars).toBe(140)
    expect(result.prunedChars).toBe(100)
    expect(result.displayContent).toContain(head)
    expect(result.displayContent).toContain(tail)
    expect(result.displayContent).toContain('已自动精简')
    expect(result.rawContent).toBe(raw)
  })

  it('counts lines and code points the same as split/Array.from', () => {
    const raw = '🚀\nok\n你好'
    const result = pruneToolOutput(raw)
    expect(result.totalLines).toBe(3)
    expect(result.totalChars).toBe(7)
  })

  // Tool outputs are immutable and re-measured on every remount, so identical
  // strings must reuse the previous result instead of walking the text again.
  it('memoises results for identical outputs', () => {
    const raw = 'x'.repeat(9000)
    const first = pruneToolOutputCached(raw)
    const second = pruneToolOutputCached(raw)
    expect(second).toBe(first)
    expect(first.totalChars).toBe(9000)
    expect(first.isPruned).toBe(true)
  })

  it('bypasses the memo for custom configs', () => {
    const raw = 'y'.repeat(9000)
    const first = pruneToolOutputCached(raw, { thresholdChars: 10 })
    const second = pruneToolOutputCached(raw, { thresholdChars: 10 })
    expect(second).not.toBe(first)
    expect(second.totalChars).toBe(first.totalChars)
  })
})
