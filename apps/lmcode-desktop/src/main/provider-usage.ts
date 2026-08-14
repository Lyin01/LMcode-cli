import type { LmcodeConfig, ProviderConfig } from '@lmcode-cli/lmcode-sdk'
import type {
  ProviderApiBalance,
  ProviderMoneyBalance,
  ProviderSubscriptionQuota,
  ProviderUsageIssue,
  ProviderUsageSnapshot,
  SubscriptionExtraUsage,
  SubscriptionQuotaRow,
  SubscriptionQuotaWindow,
} from '../shared/provider-usage-types.js'
import { resolveUsageEndpoint } from './usage-endpoints.js'

const DEFAULT_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000

export interface ProviderUsageServiceOptions {
  readonly loadConfig: () => Promise<LmcodeConfig>
  readonly fetchImpl?: typeof fetch
  readonly cacheTtlMs?: number
  readonly requestTimeoutMs?: number
  readonly now?: () => number
}

export interface ProviderUsageFetchOptions {
  readonly fetchImpl?: typeof fetch
  readonly requestTimeoutMs?: number
  readonly now?: () => number
}

interface ApiBalanceTarget {
  readonly kind: 'api-balance'
  readonly service: 'deepseek' | 'moonshot'
  readonly providerId: string
  readonly url: string
  readonly apiKey: string
  readonly currencyHint?: string
}

interface SubscriptionTarget {
  readonly kind: 'subscription-quota'
  readonly providerId: string
  readonly url: string
  readonly apiKey: string
}

type ProviderUsageTarget = ApiBalanceTarget | SubscriptionTarget

type ProviderUsageTargetResult =
  | { readonly kind: 'api-balance'; readonly value: ProviderApiBalance }
  | { readonly kind: 'subscription-quota'; readonly value: ProviderSubscriptionQuota }
  | { readonly kind: 'error'; readonly issue: ProviderUsageIssue }

export interface ParsedSubscriptionUsage {
  readonly summary: SubscriptionQuotaRow | null
  readonly limits: readonly SubscriptionQuotaRow[]
  readonly extraUsage: SubscriptionExtraUsage | null
}

export class ProviderUsageService {
  private readonly loadConfig: () => Promise<LmcodeConfig>
  private readonly fetchImpl: typeof fetch
  private readonly cacheTtlMs: number
  private readonly requestTimeoutMs: number
  private readonly now: () => number
  private cached: ProviderUsageSnapshot | null = null
  private cacheExpiresAt = 0
  private inFlight: Promise<ProviderUsageSnapshot> | null = null
  private generation = 0

  constructor(options: ProviderUsageServiceOptions) {
    this.loadConfig = options.loadConfig
    this.fetchImpl = options.fetchImpl ?? fetch
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    this.now = options.now ?? Date.now
  }

  async get(force = false): Promise<ProviderUsageSnapshot> {
    const now = this.now()
    if (!force && this.cached !== null && now < this.cacheExpiresAt) return this.cached
    if (this.inFlight !== null) return this.inFlight

    const generation = this.generation
    const pending = this.load()
    this.inFlight = pending
    try {
      const snapshot = await pending
      if (generation === this.generation) {
        this.cached = snapshot
        this.cacheExpiresAt = this.now() + this.cacheTtlMs
      }
      return snapshot
    } finally {
      if (this.inFlight === pending) this.inFlight = null
    }
  }

  invalidate(): void {
    this.generation += 1
    this.cached = null
    this.cacheExpiresAt = 0
    this.inFlight = null
  }

  private async load(): Promise<ProviderUsageSnapshot> {
    return fetchConfiguredProviderUsage(await this.loadConfig(), {
      fetchImpl: this.fetchImpl,
      requestTimeoutMs: this.requestTimeoutMs,
      now: this.now,
    })
  }
}

export async function fetchConfiguredProviderUsage(
  config: LmcodeConfig,
  options: ProviderUsageFetchOptions = {},
): Promise<ProviderUsageSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const now = options.now ?? Date.now
  const { targets, issues: discoveryIssues } = discoverUsageTargets(config)
  const results = await Promise.all(
    targets.map((target) => queryUsageTarget(target, fetchImpl, requestTimeoutMs)),
  )
  const apiBalances: ProviderApiBalance[] = []
  const subscriptions: ProviderSubscriptionQuota[] = []
  const issues = [...discoveryIssues]

  for (const result of results) {
    switch (result.kind) {
      case 'api-balance':
        apiBalances.push(result.value)
        break
      case 'subscription-quota':
        subscriptions.push(result.value)
        break
      case 'error':
        issues.push(result.issue)
        break
    }
  }

  return {
    apiBalances,
    subscriptions,
    issues,
    fetchedAt: now(),
  }
}

function discoverUsageTargets(config: LmcodeConfig): {
  readonly targets: readonly ProviderUsageTarget[]
  readonly issues: readonly ProviderUsageIssue[]
} {
  const targets: ProviderUsageTarget[] = []
  const issues: ProviderUsageIssue[] = []
  const seen = new Set<string>()

  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.enabled === false || provider.baseUrl === undefined) continue
    const endpoint = resolveUsageEndpoint(provider.baseUrl)
    if (endpoint === null) continue
    const apiKey = providerApiKey(provider)
    if (apiKey === undefined) {
      issues.push({
        providerId,
        kind: endpoint.kind,
        message: '未配置可用于查询用量的 API Key',
      })
      continue
    }
    const dedupeKey = `${endpoint.kind}\0${endpoint.url}\0${apiKey}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    if (endpoint.kind === 'subscription-quota') {
      targets.push({ kind: endpoint.kind, providerId, url: endpoint.url, apiKey })
    } else {
      targets.push({
        kind: endpoint.kind,
        service: endpoint.service,
        providerId,
        url: endpoint.url,
        apiKey,
        currencyHint: endpoint.currencyHint,
      })
    }
  }

  return { targets, issues }
}


function providerApiKey(provider: ProviderConfig): string | undefined {
  const configured = nonEmpty(provider.apiKey)
  if (configured !== undefined) return configured
  switch (provider.type) {
    case 'anthropic':
      return nonEmpty(provider.env?.['ANTHROPIC_API_KEY'])
    case 'openai':
    case 'openai_responses':
      return nonEmpty(provider.env?.['OPENAI_API_KEY'])
    case 'lmcode':
      return nonEmpty(provider.env?.['LMCODE_API_KEY'])
    case 'google-genai':
      return nonEmpty(provider.env?.['GOOGLE_API_KEY'])
    case 'vertexai':
      return nonEmpty(provider.env?.['VERTEXAI_API_KEY']) ?? nonEmpty(provider.env?.['GOOGLE_API_KEY'])
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

async function queryUsageTarget(
  target: ProviderUsageTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProviderUsageTargetResult> {
  const controller = new AbortController()
  const timer: NodeJS.Timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      return usageError(target, `HTTP ${String(response.status)}`)
    }
    const payload: unknown = await response.json()
    if (target.kind === 'subscription-quota') {
      const parsed = parseSubscriptionUsagePayload(payload)
      if (parsed.summary === null && parsed.limits.length === 0 && parsed.extraUsage === null) {
        return usageError(target, '服务返回了无法识别的额度数据')
      }
      return {
        kind: target.kind,
        value: { providerId: target.providerId, ...parsed },
      }
    }

    const balances = target.service === 'deepseek'
      ? parseDeepSeekBalancePayload(payload)
      : parseMoonshotBalancePayload(payload, target.currencyHint ?? 'USD')
    if (balances.length === 0) return usageError(target, '服务返回了无法识别的余额数据')
    return {
      kind: target.kind,
      value: { providerId: target.providerId, balances },
    }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '请求超时'
      : '网络请求失败'
    return usageError(target, message)
  } finally {
    clearTimeout(timer)
  }
}

function usageError(
  target: ProviderUsageTarget,
  message: string,
): ProviderUsageTargetResult {
  return {
    kind: 'error',
    issue: { providerId: target.providerId, kind: target.kind, message },
  }
}

export function parseDeepSeekBalancePayload(payload: unknown): ProviderMoneyBalance[] {
  if (!isRecord(payload) || !Array.isArray(payload['balance_infos'])) return []
  const balances: ProviderMoneyBalance[] = []
  for (const raw of payload['balance_infos']) {
    if (!isRecord(raw)) continue
    const currency = normalizedCurrency(raw['currency'])
    const available = finiteNumber(raw['total_balance'])
    if (currency === null || available === null) continue
    balances.push({
      currency,
      available,
      cash: finiteNumber(raw['topped_up_balance']) ?? undefined,
      bonus: finiteNumber(raw['granted_balance']) ?? undefined,
    })
  }
  return balances
}

export function parseMoonshotBalancePayload(
  payload: unknown,
  currency: string,
): ProviderMoneyBalance[] {
  if (!isRecord(payload) || !isRecord(payload['data'])) return []
  const data = payload['data']
  const available = finiteNumber(data['available_balance'])
  if (available === null) return []
  return [{
    currency,
    available,
    cash: finiteNumber(data['cash_balance']) ?? undefined,
    bonus: finiteNumber(data['voucher_balance']) ?? undefined,
  }]
}

export function parseSubscriptionUsagePayload(payload: unknown): ParsedSubscriptionUsage {
  if (!isRecord(payload)) return { summary: null, limits: [], extraUsage: null }
  let summary = quotaRow(payload['usage'])
  if (summary !== null && summary.window === undefined) {
    summary = { ...summary, window: { duration: 1, unit: 'week' } }
  }
  const limits: SubscriptionQuotaRow[] = []
  const rawLimits = payload['limits']
  if (Array.isArray(rawLimits)) {
    for (const item of rawLimits) {
      if (!isRecord(item)) continue
      const row = quotaRow(item['detail'], {
        name: text(item['name']),
        window: quotaWindow(item['window']),
      })
      if (row !== null) limits.push(row)
    }
  }
  return {
    summary,
    limits,
    extraUsage: parseExtraUsage(payload['boosterWallet']),
  }
}

function quotaRow(
  raw: unknown,
  extra: { readonly name?: string; readonly window?: SubscriptionQuotaWindow } = {},
): SubscriptionQuotaRow | null {
  if (!isRecord(raw)) return null
  const used = nonNegativeInteger(raw['used'])
  const limit = nonNegativeInteger(raw['limit'])
  if (used === null && limit === null) return null
  return {
    name: extra.name ?? text(raw['name']),
    window: extra.window,
    used: used ?? 0,
    limit: limit ?? 0,
    resetAt: text(raw['resetTime']),
  }
}

function quotaWindow(raw: unknown): SubscriptionQuotaWindow | undefined {
  if (!isRecord(raw)) return undefined
  const duration = nonNegativeInteger(raw['duration'])
  const unit = quotaUnit(raw['timeUnit'])
  if (duration === null || duration === 0 || unit === null) return undefined
  if (unit === 'minute' && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: 'hour' }
  }
  return { duration, unit }
}

function quotaUnit(raw: unknown): SubscriptionQuotaWindow['unit'] | null {
  switch (raw) {
    case 'TIME_UNIT_MINUTE':
      return 'minute'
    case 'TIME_UNIT_HOUR':
      return 'hour'
    case 'TIME_UNIT_DAY':
      return 'day'
    case 'TIME_UNIT_WEEK':
      return 'week'
    default:
      return null
  }
}

function parseExtraUsage(raw: unknown): SubscriptionExtraUsage | null {
  if (!isRecord(raw) || !isRecord(raw['balance'])) return null
  const balance = raw['balance']
  if (balance['type'] !== 'BOOSTER') return null
  const totalRaw = nonNegativeInteger(balance['amount'])
  if (totalRaw === null || totalRaw === 0) return null
  const balanceRaw = nonNegativeInteger(balance['amountLeft']) ?? 0
  const currency = moneyCurrency(raw['monthlyChargeLimit'])
    ?? moneyCurrency(raw['monthlyUsed'])
    ?? 'USD'
  return {
    balanceCents: fixedPointToCents(balanceRaw),
    totalCents: fixedPointToCents(totalRaw),
    currency,
  }
}

function fixedPointToCents(value: number): number {
  const cents = value / 1_000_000
  if (cents > 0 && cents < 1) return 1
  return Math.round(cents)
}

function moneyCurrency(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  return normalizedCurrency(raw['currency'])
}

function normalizedCurrency(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(value) ? value : null
}

function finiteNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function nonNegativeInteger(raw: unknown): number | null {
  const value = finiteNumber(raw)
  return value === null || value < 0 ? null : Math.trunc(value)
}

function text(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
