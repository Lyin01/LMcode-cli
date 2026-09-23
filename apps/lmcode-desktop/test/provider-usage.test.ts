import { describe, expect, it, vi } from 'vitest'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import {
  fetchConfiguredProviderUsage,
  parseCommandCodeUsagePayload,
  parseMoonshotBalancePayload,
  parseOpenCodeGoUsagePayload,
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

    await service.get(true)
    expect(loadConfig).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('releases the body of a failed usage request instead of leaving it dangling', async () => {
    const config: LmcodeConfig = {
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'key',
        },
      },
    }
    const responses: Response[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"too many requests"}'))
        },
      })
      const response = new Response(stream, { status: 429 })
      responses.push(response)
      return response
    })

    const snapshot = await fetchConfiguredProviderUsage(config, {
      fetchImpl: fetchMock,
      now: () => 1,
    })

    // An untouched body holds its connection until the GC collects it, so a provider
    // answering 429 on every 60s poll would strand one connection per round.
    expect(responses[0]?.bodyUsed).toBe(true)
    expect(snapshot.apiBalances).toEqual([])
    expect(snapshot.issues).toEqual([
      { providerId: 'deepseek', kind: 'api-balance', message: 'HTTP 429' },
    ])
  })

  it('never answers with a round that an invalidate superseded', async () => {
    const config: LmcodeConfig = {
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'key',
        },
      },
    }
    const rounds: PromiseWithResolvers<Response>[] = []
    const fetchMock = vi.fn<typeof fetch>(() => {
      const round = Promise.withResolvers<Response>()
      rounds.push(round)
      return round.promise
    })
    const service = new ProviderUsageService({
      loadConfig: async () => config,
      fetchImpl: fetchMock,
      cacheTtlMs: 100,
      now: () => 2_000,
    })

    const refresh = service.get()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    // A provider-config write lands while the round is in flight: its payload
    // describes the providers the user just replaced.
    service.invalidate()
    rounds[0]!.resolve(jsonResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '11' }],
    }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    rounds[1]!.resolve(jsonResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '222' }],
    }))

    const snapshot = await refresh

    expect(snapshot.apiBalances[0]?.balances[0]?.available).toBe(222)
    // The current generation's snapshot is the one that got cached.
    const cached = await service.get()
    expect(cached.apiBalances[0]?.balances[0]?.available).toBe(222)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves the current generation to callers that raced a superseding refresh', async () => {
    const config: LmcodeConfig = {
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'key',
        },
      },
    }
    const rounds: PromiseWithResolvers<Response>[] = []
    const fetchMock = vi.fn<typeof fetch>(() => {
      const round = Promise.withResolvers<Response>()
      rounds.push(round)
      return round.promise
    })
    const service = new ProviderUsageService({
      loadConfig: async () => config,
      fetchImpl: fetchMock,
      now: () => 1_000,
    })

    const background = service.get()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const manual = service.get(true)
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    rounds[0]!.resolve(jsonResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '11' }],
    }))
    rounds[1]!.resolve(jsonResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '222' }],
    }))

    const [backgroundSnapshot, manualSnapshot] = await Promise.all([background, manual])

    expect(manualSnapshot.apiBalances[0]?.balances[0]?.available).toBe(222)
    expect(backgroundSnapshot.apiBalances[0]?.balances[0]?.available).toBe(222)
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

  it('queries OpenCode Go usage once and attributes it to the default provider', async () => {
    const config: LmcodeConfig = {
      defaultProvider: 'opencode-go-rsp',
      defaultModel: 'opencode-go-rsp/deepseek-v4-flash',
      models: {
        'opencode-go-rsp/deepseek-v4-flash': {
          provider: 'opencode-go-rsp',
          model: 'deepseek-v4-flash',
          maxContextSize: 100000,
        },
      },
      providers: {
        'opencode-go': {
          type: 'openai',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          apiKey: 'go-secret',
        },
        'opencode-go-rsp': {
          type: 'openai_responses',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          apiKey: 'go-secret',
        },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      usage: {
        rolling: { status: 'ok', percent: 38.4, resetsAt: '2026-08-16T20:00:00Z' },
        weekly: { status: 'ok', percent: 62, resetsAt: '2026-08-17T00:00:00Z' },
        monthly: { status: 'ok', percent: 11, resetsAt: '2026-09-01T00:00:00Z' },
      },
    }))

    const snapshot = await fetchConfiguredProviderUsage(config, {
      fetchImpl: fetchMock,
      now: () => 1234,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(snapshot.subscriptions).toHaveLength(1)
    expect(snapshot.subscriptions[0]?.providerId).toBe('opencode-go-rsp')
    expect(snapshot.subscriptions[0]?.summary).toMatchObject({ name: '滚动', used: 38, limit: 100 })
    expect(snapshot.subscriptions[0]?.limits).toHaveLength(2)
    expect(snapshot.subscriptions[0]?.limits[1]).toMatchObject({ name: '每月', used: 11 })
  })

  it('rejects malformed OpenCode Go usage payloads', () => {
    expect(parseOpenCodeGoUsagePayload({ usage: { rolling: { status: 'ok' } } })).toBeNull()
    expect(parseOpenCodeGoUsagePayload({ usage: { rolling: { status: 'ok', percent: 5, resetsAt: 'not-a-date' } } })).toBeNull()
    expect(parseOpenCodeGoUsagePayload(null)).toBeNull()
  })

  it('queries Command Code billing with the provider key and sizes the monthly grant', async () => {
    const config: LmcodeConfig = {
      defaultProvider: 'command-code',
      providers: {
        'command-code': {
          type: 'openai',
          baseUrl: 'https://api.commandcode.ai/provider/v1',
          apiKey: 'cmd-secret',
        },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input)
      if (url === 'https://api.commandcode.ai/alpha/billing/credits') {
        return jsonResponse({
          credits: { monthlyCredits: 8.7784, purchasedCredits: 0 },
          windowLimits: {
            fiveHour: { cap: 3, used: 0.75, resetAt: 1_780_000_000_000 },
            weekly: { cap: 15, used: 1.5, resetAt: 1_780_100_000_000 },
          },
        })
      }
      if (url === 'https://api.commandcode.ai/alpha/billing/subscriptions') {
        return jsonResponse({
          success: true,
          data: {
            status: 'active',
            planId: 'individual-goat',
            currentPeriodEnd: '2026-08-23T18:08:48.000Z',
          },
        })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 404)
    })

    const snapshot = await fetchConfiguredProviderUsage(config, {
      fetchImpl: fetchMock,
      now: () => 1234,
    })

    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input)).toSorted()).toEqual([
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/billing/subscriptions',
    ])
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer cmd-secret',
      'x-api-key': 'cmd-secret',
    })

    const quota = snapshot.subscriptions[0]
    expect(quota?.providerId).toBe('command-code')
    expect(quota?.summary).toMatchObject({ name: '5小时', used: 0.75, limit: 3 })
    expect(quota?.summary?.resetAt).toBe(new Date(1_780_000_000_000).toISOString())
    expect(quota?.limits.map((row) => row.name)).toEqual(['每周', '每月'])
    const monthly = quota?.limits[1]
    expect(monthly?.limit).toBe(70)
    expect(monthly?.used).toBeCloseTo(61.2216, 4)
    expect(monthly?.resetAt).toBe('2026-08-23T18:08:48.000Z')
    expect(snapshot.issues).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('cmd-secret')
  })

  it('keeps Command Code window rows when the plan lookup fails', async () => {
    const config: LmcodeConfig = {
      providers: {
        'command-code': {
          type: 'anthropic',
          baseUrl: 'https://api.commandcode.ai/provider/v1',
          apiKey: 'cmd-secret',
        },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      requestUrl(input).endsWith('/alpha/billing/credits')
        ? jsonResponse({
          credits: { monthlyCredits: 9.15 },
          windowLimits: {
            fiveHour: { cap: 3, used: 0.75, resetAt: 1_780_000_000_000 },
            weekly: { cap: 6, used: 1.5, resetAt: 1_780_100_000_000 },
          },
        })
        : jsonResponse({ error: 'boom' }, 503),
    )

    const snapshot = await fetchConfiguredProviderUsage(config, {
      fetchImpl: fetchMock,
      now: () => 1,
    })

    expect(snapshot.issues).toEqual([])
    const quota = snapshot.subscriptions[0]
    expect(quota?.providerId).toBe('command-code')
    expect(quota?.summary).toMatchObject({ name: '5小时' })
    expect(quota?.limits.map((row) => row.name)).toEqual(['每周'])
  })

  it('rejects Command Code payloads without usable windows or credits', () => {
    expect(parseCommandCodeUsagePayload(null, undefined)).toBeNull()
    expect(parseCommandCodeUsagePayload({ windowLimits: {} }, undefined)).toBeNull()
    expect(
      parseCommandCodeUsagePayload({ windowLimits: { fiveHour: { cap: 0, used: 0 } } }, undefined),
    ).toBeNull()
    expect(parseCommandCodeUsagePayload({ credits: { monthlyCredits: 8 } }, undefined)).toBeNull()
    expect(
      parseCommandCodeUsagePayload(
        { credits: { monthlyCredits: 8 } },
        { success: true, data: { planId: 'individual-unknown' } },
      ),
    ).toBeNull()
    expect(
      parseCommandCodeUsagePayload(
        { credits: { monthlyCredits: 8 } },
        { success: true, data: { planId: 'Individual-Go' } },
      )?.summary,
    ).toMatchObject({ name: '每月', used: 2, limit: 10 })
  })
})
