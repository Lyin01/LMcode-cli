import { describe, it, expect } from 'vitest'
import { pruneToolOutput, codePointLength, formatCharCount } from '../src/renderer/lib/tool-pruner'

describe('tool-pruner', () => {
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
})
