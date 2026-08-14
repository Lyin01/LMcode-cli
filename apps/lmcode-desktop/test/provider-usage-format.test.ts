import { describe, expect, it } from 'vitest'
import {
  buildProviderUsageDisplay,
  remainingQuotaPercent,
} from '../src/renderer/lib/provider-usage'
import type { ProviderUsageSnapshot } from '../src/shared/provider-usage-types'

describe('provider usage footer formatting', () => {
  it('shows remaining API money and subscription percentages', () => {
    const snapshot: ProviderUsageSnapshot = {
      apiBalances: [{
        providerId: 'deepseek',
        balances: [{ currency: 'CNY', available: 110 }],
      }],
      subscriptions: [{
        providerId: 'kimi-for-coding',
        summary: { used: 170, limit: 1000, window: { duration: 1, unit: 'week' } },
        limits: [{ used: 28, limit: 100, window: { duration: 5, unit: 'hour' } }],
        extraUsage: null,
      }],
      issues: [],
      fetchedAt: 1,
    }

    expect(buildProviderUsageDisplay(snapshot)).toMatchObject({
      apiText: 'API 余额 · deepseek ¥110.00',
      subscriptionText: '订阅额度 · kimi-for-coding 周剩余 83% · 5小时剩余 72%',
      hasIssues: false,
    })
  })

  it('clamps exhausted quotas and reports unavailable endpoints', () => {
    expect(remainingQuotaPercent({ used: 12, limit: 10 })).toBe(0)
    expect(remainingQuotaPercent({ used: 0, limit: 0 })).toBeNull()

    const snapshot: ProviderUsageSnapshot = {
      apiBalances: [],
      subscriptions: [],
      issues: [{ providerId: 'deepseek', kind: 'api-balance', message: 'HTTP 401' }],
      fetchedAt: 1,
    }
    expect(buildProviderUsageDisplay(snapshot)).toMatchObject({
      apiText: 'API 余额 · 查询失败',
      subscriptionText: '订阅额度 · 未配置',
      hasIssues: true,
    })
  })
})
