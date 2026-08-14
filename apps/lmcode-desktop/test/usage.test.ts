import { describe, expect, it } from 'vitest'
import { summarizeUsage, evaluateContextPressure } from '../src/renderer/lib/usage'

describe('summarizeUsage', () => {
  it('flattens the session total into an input/output/cache aggregate', () => {
    const summary = summarizeUsage({
      total: { inputOther: 100, output: 50, inputCacheRead: 30, inputCacheCreation: 20 },
    })

    expect(summary).toEqual({
      inputTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    })
  })

  it('reports nothing when usage or its total is absent', () => {
    expect(summarizeUsage(undefined)).toBeUndefined()
    expect(summarizeUsage({})).toBeUndefined()
    expect(
      summarizeUsage({
        currentTurn: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      }),
    ).toBeUndefined()
  })
})

describe('evaluateContextPressure', () => {
  it('returns normal pressure for empty or zero maxTokens', () => {
    const pressure = evaluateContextPressure(100, 0)
    expect(pressure.level).toBe('normal')
    expect(pressure.percentage).toBe(0)
    expect(pressure.isNearLimit).toBe(false)
  })

  it('evaluates normal pressure under 70%', () => {
    const pressure = evaluateContextPressure(60_000, 100_000)
    expect(pressure.level).toBe('normal')
    expect(pressure.percentage).toBe(60)
    expect(pressure.remainingTokens).toBe(40_000)
    expect(pressure.isNearLimit).toBe(false)
  })

  it('evaluates warning pressure between 70% and 90%', () => {
    const pressure = evaluateContextPressure(75_000, 100_000)
    expect(pressure.level).toBe('warning')
    expect(pressure.percentage).toBe(75)
    expect(pressure.remainingTokens).toBe(25_000)
    expect(pressure.isNearLimit).toBe(true)
  })

  it('evaluates critical pressure at 90% or above', () => {
    const pressure = evaluateContextPressure(95_000, 100_000)
    expect(pressure.level).toBe('critical')
    expect(pressure.percentage).toBe(95)
    expect(pressure.remainingTokens).toBe(5_000)
    expect(pressure.isNearLimit).toBe(true)
  })
})
