import { describe, expect, it } from 'vitest'

import { summarizeUsage } from '../src/renderer/lib/usage'

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
    expect(summarizeUsage({ currentTurn: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } })).toBeUndefined()
  })
})
