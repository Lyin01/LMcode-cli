import { describe, expect, it, vi } from 'vitest'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import {
  fetchConfiguredProviderUsage,
  parseMoonshotBalancePayload,
  parseSubscriptionUsagePayload,
  ProviderUsageService,
} from '../src/main/provider-usage'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('desktop provider usage', () => {
  it('queries supported official endpoints and never returns credentials', async () => {
    const config: LmcodeConfig = {
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'deepseek-secret',
        },
        'kimi-for-coding': {
          type: 'anthropic',
          baseUrl: 'https://api.kimi.com/coding',
          apiKey: 'kimi-secret',
        },
        custom: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com.example.test/v1',
          apiKey: 'custom-secret',
        },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input)
      if (url.endsWith('/user/balance')) {
        return jsonResponse({
          balance_infos: [{
            currency: 'CNY',
            total_balance: '110.25',
            topped_up_balance: '100.00',
            granted_balance: '10.25',
          }],
        })
      }
      if (url.endsWith('/coding/v1/usages')) {
        return jsonResponse({
          usage: { used: '170', limit: '1000', resetTime: '2026-08-03T05:20:51Z' },
          limits: [{
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { used: '28', limit: '100' },
          }],
          boosterWallet: {
            balance: { type: 'BOOSTER', amount: '500000000', amountLeft: '250000000' },
            monthlyUsed: { priceInCents: 10, currency: 'USD' },
          },
        })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 404)
    })

    const snapshot = await fetchConfiguredProviderUsage(config, {
      fetchImpl: fetchMock,
      now: () => 1234,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      'https://api.deepseek.com/user/balance',
      'https://api.kimi.com/coding/v1/usages',
    ])
    expect(snapshot.apiBalances[0]?.balances[0]).toEqual({
      currency: 'CNY',
      available: 110.25,
      cash: 100,
      bonus: 10.25,
    })
    expect(snapshot.subscriptions[0]?.summary).toMatchObject({ used: 170, limit: 1000 })
    expect(snapshot.subscriptions[0]?.limits[0]?.window).toEqual({ duration: 5, unit: 'hour' })
    expect(snapshot.subscriptions[0]?.extraUsage).toEqual({
      balanceCents: 250,
      totalCents: 500,
      currency: 'USD',
    })
    expect(snapshot.fetchedAt).toBe(1234)
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('deduplicates concurrent requests and serves a short-lived cache', async () => {
    let now = 1_000
    const config: LmcodeConfig = {
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'key',
        },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '1' }],
    }))
    const loadConfig = vi.fn(async () => config)
    const service = new ProviderUsageService({
      loadConfig,
      fetchImpl: fetchMock,
      cacheTtlMs: 100,
      now: () => now,
    })

    await Promise.all([service.get(), service.get()])
    await service.get()
    expect(loadConfig).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now = 1_101
    await service.get()
    expect(loadConfig).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('normalizes Kimi quota windows and parses Moonshot balances', () => {
    const usage = parseSubscriptionUsagePayload({
      usage: { used: 1, limit: 10 },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { used: 2, limit: 20 },
      }],
    })

    expect(usage.summary?.window).toEqual({ duration: 1, unit: 'week' })
    expect(usage.limits[0]?.window).toEqual({ duration: 5, unit: 'hour' })
    expect(parseMoonshotBalancePayload({
      data: { available_balance: 49.5, cash_balance: 40, voucher_balance: 9.5 },
    }, 'USD')).toEqual([{
      currency: 'USD',
      available: 49.5,
      cash: 40,
      bonus: 9.5,
    }])
  })
})
