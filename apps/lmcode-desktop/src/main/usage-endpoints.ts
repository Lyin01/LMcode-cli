const KIMI_CODE_HOST = 'api.kimi.com'
const DEEPSEEK_HOST = 'api.deepseek.com'
const MOONSHOT_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai'])
const OPENCODE_GO_HOST = 'opencode.ai'
const OPENCODE_GO_USAGE_PATH = '/zen/go/v1/usage'

// ---------------------------------------------------------------------------
// Usage-endpoint registry
// ---------------------------------------------------------------------------
//
// `resolveUsageEndpoint` maps a provider base URL to a balance/quota query
// endpoint. Built-in providers are registered at module load; external code
// can register its own host rules through `registerUsageEndpointProvider`,
// mirroring the plugin-extension pattern used elsewhere in the harness.
// ---------------------------------------------------------------------------

export interface ApiBalanceEndpoint {
  readonly kind: 'api-balance'
  readonly service: 'deepseek' | 'moonshot'
  readonly url: string
  readonly currencyHint?: string
}

export interface SubscriptionQuotaEndpoint {
  readonly kind: 'subscription-quota'
  readonly url: string
}

export interface OpenCodeGoEndpoint {
  readonly kind: 'opencode-go'
  readonly url: string
}

export type UsageEndpoint = ApiBalanceEndpoint | SubscriptionQuotaEndpoint | OpenCodeGoEndpoint

/**
 * A rule that maps a provider base URL to a usage-query endpoint. `match`
 * returns `null` when the URL does not belong to this provider.
 */
export interface UsageEndpointProvider {
  readonly name: string
  match(baseUrl: string): UsageEndpoint | null
}

const endpointProviders: UsageEndpointProvider[] = []

/**
 * Registers a usage-endpoint provider. Registered providers are consulted in
 * registration order by {@link resolveUsageEndpoint}; the first match wins.
 */
export function registerUsageEndpointProvider(provider: UsageEndpointProvider): void {
  endpointProviders.push(provider)
}

/**
 * Resolves a provider base URL to a usage-query endpoint by consulting all
 * registered providers in order. Returns `null` when no provider matches.
 */
export function resolveUsageEndpoint(baseUrl: string): UsageEndpoint | null {
  for (const provider of endpointProviders) {
    const endpoint = provider.match(baseUrl)
    if (endpoint !== null) return endpoint
  }
  return null
}

function parseHttpsUrl(baseUrl: string): URL | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  return url
}

registerUsageEndpointProvider({
  name: 'deepseek',
  match(baseUrl) {
    const url = parseHttpsUrl(baseUrl)
    if (url === null || url.hostname.toLowerCase() !== DEEPSEEK_HOST) return null
    return {
      kind: 'api-balance',
      service: 'deepseek',
      url: `${url.origin}/user/balance`,
      currencyHint: undefined,
    }
  },
})

registerUsageEndpointProvider({
  name: 'moonshot',
  match(baseUrl) {
    const url = parseHttpsUrl(baseUrl)
    if (url === null) return null
    const hostname = url.hostname.toLowerCase()
    if (!MOONSHOT_HOSTS.has(hostname)) return null
    return {
      kind: 'api-balance',
      service: 'moonshot',
      url: `${url.origin}/v1/users/me/balance`,
      currencyHint: hostname.endsWith('.cn') ? 'CNY' : 'USD',
    }
  },
})

registerUsageEndpointProvider({
  name: 'kimi',
  match(baseUrl) {
    const url = parseHttpsUrl(baseUrl)
    if (url === null) return null
    const hostname = url.hostname.toLowerCase()
    const path = url.pathname.replace(/\/+$/, '')
    if (hostname !== KIMI_CODE_HOST || (path !== '/coding' && path !== '/coding/v1')) return null
    return {
      kind: 'subscription-quota',
      url: `${url.origin}/coding/v1/usages`,
    }
  },
})

registerUsageEndpointProvider({
  name: 'opencode-go',
  match(baseUrl) {
    const url = parseHttpsUrl(baseUrl)
    if (url === null || url.hostname.toLowerCase() !== OPENCODE_GO_HOST) return null
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== '/zen/go' && path !== '/zen/go/v1') return null
    return {
      kind: 'opencode-go',
      url: `${url.origin}${OPENCODE_GO_USAGE_PATH}`,
    }
  },
})
