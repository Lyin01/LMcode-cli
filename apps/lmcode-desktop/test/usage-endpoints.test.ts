import { describe, expect, it } from 'vitest'
import {
  registerUsageEndpointProvider,
  resolveUsageEndpoint,
} from '../src/main/usage-endpoints'

describe('usage endpoint registry', () => {
  it('resolves the built-in DeepSeek balance endpoint', () => {
    expect(resolveUsageEndpoint('https://api.deepseek.com/v1')).toEqual({
      kind: 'api-balance',
      service: 'deepseek',
      url: 'https://api.deepseek.com/user/balance',
      currencyHint: undefined,
    })
  })

  it('resolves the built-in Moonshot balance endpoint with currency hint', () => {
    expect(resolveUsageEndpoint('https://api.moonshot.cn/v1')).toEqual({
      kind: 'api-balance',
      service: 'moonshot',
      url: 'https://api.moonshot.cn/v1/users/me/balance',
      currencyHint: 'CNY',
    })
    expect(resolveUsageEndpoint('https://api.moonshot.ai/v1')).toEqual({
      kind: 'api-balance',
      service: 'moonshot',
      url: 'https://api.moonshot.ai/v1/users/me/balance',
      currencyHint: 'USD',
    })
  })

  it('resolves the built-in Kimi subscription quota endpoint', () => {
    expect(resolveUsageEndpoint('https://api.kimi.com/coding')).toEqual({
      kind: 'subscription-quota',
      url: 'https://api.kimi.com/coding/v1/usages',
    })
    expect(resolveUsageEndpoint('https://api.kimi.com/coding/v1')).toEqual({
      kind: 'subscription-quota',
      url: 'https://api.kimi.com/coding/v1/usages',
    })
  })

  it('rejects non-https, unknown, or malformed base URLs', () => {
    expect(resolveUsageEndpoint('http://api.deepseek.com/v1')).toBeNull()
    expect(resolveUsageEndpoint('https://unknown.example/v1')).toBeNull()
    expect(resolveUsageEndpoint('not-a-url')).toBeNull()
  })

  it('resolves a custom registered endpoint provider', () => {
    registerUsageEndpointProvider({
      name: 'custom-test',
      match(baseUrl) {
        if (!baseUrl.includes('usage-endpoints.test.local')) return null
        return {
          kind: 'api-balance',
          service: 'deepseek',
          url: `${baseUrl}/balance`,
        }
      },
    })
    expect(resolveUsageEndpoint('https://usage-endpoints.test.local/v1')).toEqual({
      kind: 'api-balance',
      service: 'deepseek',
      url: 'https://usage-endpoints.test.local/v1/balance',
    })
  })
})
