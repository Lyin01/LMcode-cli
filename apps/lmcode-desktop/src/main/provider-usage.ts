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

const DEFAULT_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
/** How many rounds `get()` may start before it settles for the freshest one it has. */
const MAX_SNAPSHOT_ATTEMPTS = 3
const KIMI_CODE_HOST = 'api.kimi.com'
const DEEPSEEK_HOST = 'api.deepseek.com'
const MOONSHOT_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai'])
const OPENCODE_GO_HOST = 'opencode.ai'
const OPENCODE_GO_USAGE_PATH = '/zen/go/v1/usage'
const COMMANDCODE_HOST = 'api.commandcode.ai'
const COMMANDCODE_CREDITS_PATH = '/alpha/billing/credits'
const COMMANDCODE_SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions'

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

interface OpenCodeGoTarget {
  readonly kind: 'opencode-go'
  readonly providerId: string
  readonly url: string
  readonly apiKey: string
}

interface CommandCodeTarget {
  readonly kind: 'command-code'
  readonly providerId: string
  readonly url: string
  readonly subscriptionsUrl: string
  readonly apiKey: string
}

type ProviderUsageTarget = ApiBalanceTarget | SubscriptionTarget | OpenCodeGoTarget | CommandCodeTarget

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
    if (force) this.invalidate()
    // A round in flight can be superseded while we await it: `invalidate()` runs on
    // every provider-config write, and the snapshot that round produces was computed
    // from the config the user just replaced. Handing it out would show the wrong
    // providers as the current usage, so look again instead — the next attempt serves
    // the cache or starts (or joins) a round for the new generation. Only the caller's
    // own request bypasses the cache; an attempt that follows a superseded round
    // settles for whatever the new generation already has.
    for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      if (!force || attempt > 0) {
        const now = this.now()
        if (this.cached !== null && now < this.cacheExpiresAt) return this.cached
      }
      const generation = this.generation
      const pending = this.inFlight ?? this.load()
      this.inFlight = pending
      try {
        const snapshot = await pending
        if (generation === this.generation) {
          this.cached = snapshot
          this.cacheExpiresAt = this.now() + this.cacheTtlMs
          return snapshot
        }
      } finally {
        if (this.inFlight === pending) this.inFlight = null
      }
    }
    // Getting here takes an unbroken stream of invalidations. Answer with one fresh
    // round — started after the invalidation we last saw — rather than parking the
    // caller forever or returning a snapshot we already know is superseded. It is
    // deliberately left uncached: no generation validated it.
    return this.load()
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

  for (const [providerId, provider] of orderedProviderEntries(config)) {
    if (provider.enabled === false || provider.baseUrl === undefined) continue
    const endpoint = usageEndpoint(provider.baseUrl)
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
    } else if (endpoint.kind === 'opencode-go') {
      targets.push({ kind: endpoint.kind, providerId, url: endpoint.url, apiKey })
    } else if (endpoint.kind === 'command-code') {
      targets.push({
        kind: endpoint.kind,
        providerId,
        url: endpoint.url,
        subscriptionsUrl: endpoint.subscriptionsUrl,
        apiKey,
      })
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

/** 默认 provider 优先，保证用量条目挂靠用户实际在用的 provider 名下。 */
function orderedProviderEntries(config: LmcodeConfig): readonly (readonly [string, ProviderConfig])[] {
  const providers = config.providers ?? {}
  const orderedIds: string[] = []
  const seen = new Set<string>()
  const append = (providerId: string | undefined): void => {
    if (providerId === undefined || seen.has(providerId) || !(providerId in providers)) return
    seen.add(providerId)
    orderedIds.push(providerId)
  }
  append(config.defaultProvider)
  if (config.defaultModel !== undefined) append(config.models?.[config.defaultModel]?.provider)
  for (const providerId of Object.keys(providers)) append(providerId)
  return orderedIds.map((providerId) => [providerId, providers[providerId]!] satisfies [string, ProviderConfig])
}

function usageEndpoint(baseUrl: string):
  | {
      readonly kind: 'api-balance'
      readonly service: 'deepseek' | 'moonshot'
      readonly url: string
      readonly currencyHint?: string
    }
  | { readonly kind: 'subscription-quota'; readonly url: string }
  | { readonly kind: 'opencode-go'; readonly url: string }
  | { readonly kind: 'command-code'; readonly url: string; readonly subscriptionsUrl: string }
  | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  const hostname = url.hostname.toLowerCase()
  if (hostname === DEEPSEEK_HOST) {
    return {
      kind: 'api-balance',
      service: 'deepseek',
      url: `${url.origin}/user/balance`,
      currencyHint: undefined,
    }
  }
  if (MOONSHOT_HOSTS.has(hostname)) {
    return {
      kind: 'api-balance',
      service: 'moonshot',
      url: `${url.origin}/v1/users/me/balance`,
      currencyHint: hostname.endsWith('.cn') ? 'CNY' : 'USD',
    }
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (hostname === KIMI_CODE_HOST && (path === '/coding' || path === '/coding/v1')) {
    return {
      kind: 'subscription-quota',
      url: `${url.origin}/coding/v1/usages`,
    }
  }
  if (hostname === OPENCODE_GO_HOST && (path === '/zen/go' || path === '/zen/go/v1')) {
    return {
      kind: 'opencode-go',
      url: `${url.origin}${OPENCODE_GO_USAGE_PATH}`,
    }
  }
  if (hostname === COMMANDCODE_HOST && (path === '/provider' || path === '/provider/v1')) {
    return {
      kind: 'command-code',
      url: `${url.origin}${COMMANDCODE_CREDITS_PATH}`,
      subscriptionsUrl: `${url.origin}${COMMANDCODE_SUBSCRIPTIONS_PATH}`,
    }
  }
  return null
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
  if (target.kind === 'command-code') {
    return queryCommandCodeUsage(target, fetchImpl, timeoutMs)
  }
  const outcome = await fetchJson(fetchImpl, target.url, target.apiKey, timeoutMs)
  if (!outcome.ok) return usageError(target, outcome.message)
  const payload = outcome.payload
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
  if (target.kind === 'opencode-go') {
    const parsed = parseOpenCodeGoUsagePayload(payload)
    if (parsed === null) {
      return usageError(target, 'OpenCode Go 返回了无法识别的用量数据')
    }
    return {
      kind: 'subscription-quota',
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

type JsonFetchOutcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string }

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<JsonFetchOutcome> {
  const controller = new AbortController()
  const timer: NodeJS.Timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      // A non-OK body is never read, and an unconsumed body keeps its connection out
      // of the pool until the GC collects it. The usage poll runs every 60s, so a
      // provider stuck on 401/429 would strand one connection per tick.
      await response.body?.cancel().catch(() => {})
      return { ok: false, message: `HTTP ${String(response.status)}` }
    }
    return { ok: true, payload: await response.json() }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '请求超时'
      : '网络请求失败'
    return { ok: false, message }
  } finally {
    clearTimeout(timer)
  }
}

/** Command Code 用量走自己的账单接口：额度行是必需数据，套餐档位只用于折算每月额度。 */
async function queryCommandCodeUsage(
  target: CommandCodeTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProviderUsageTargetResult> {
  const extraHeaders = { 'x-api-key': target.apiKey }
  const [credits, subscription] = await Promise.all([
    fetchJson(fetchImpl, target.url, target.apiKey, timeoutMs, extraHeaders),
    fetchJson(fetchImpl, target.subscriptionsUrl, target.apiKey, timeoutMs, extraHeaders),
  ])
  if (!credits.ok) return usageError(target, credits.message)
  const parsed = parseCommandCodeUsagePayload(
    credits.payload,
    subscription.ok ? subscription.payload : null,
  )
  if (parsed === null) {
    return usageError(target, 'Command Code 返回了无法识别的额度数据')
  }
  return {
    kind: 'subscription-quota',
    value: { providerId: target.providerId, ...parsed },
  }
}

export function parseOpenCodeGoUsagePayload(payload: unknown): ParsedSubscriptionUsage | null {
  if (!isRecord(payload) || !isRecord(payload['usage'])) return null
  const usage = payload['usage']
  const rows: SubscriptionQuotaRow[] = []
  for (const window of OPENCODE_GO_USAGE_WINDOWS) {
    const period = usage[window.key]
    if (!isRecord(period)) continue
    const percent = finiteNumber(period['percent'])
    const resetsAt = text(period['resetsAt'])
    if (percent === null || percent < 0 || resetsAt === undefined || !Number.isFinite(Date.parse(resetsAt))) {
      continue
    }
    rows.push({ name: window.label, used: Math.round(percent), limit: 100, resetAt: resetsAt })
  }
  if (rows.length === 0) return null
  const [summary, ...limits] = rows
  return { summary: summary ?? null, limits, extraUsage: null }
}

const OPENCODE_GO_USAGE_WINDOWS = [
  { key: 'rolling', label: '滚动' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
] as const

/**
 * Command Code 账单接口返回的是**剩余** `monthlyCredits`，不是套餐总额；
 * 月额度按公开定价页的套餐档位（planId → 每月额度，美元）折算。
 */
const COMMAND_CODE_PLANS = [
  { id: 'individual-go', monthlyCredits: 10 },
  { id: 'individual-goat', monthlyCredits: 70 },
  { id: 'individual-pro', monthlyCredits: 30 },
  { id: 'individual-pro-v1', monthlyCredits: 80 },
  { id: 'individual-max', monthlyCredits: 150 },
  { id: 'individual-ultra', monthlyCredits: 300 },
] as const

export function parseCommandCodeUsagePayload(
  creditsPayload: unknown,
  subscriptionsPayload: unknown,
): ParsedSubscriptionUsage | null {
  if (!isRecord(creditsPayload)) return null
  const windowLimits = creditsPayload['windowLimits']
  const limits: Record<string, unknown> = isRecord(windowLimits) ? windowLimits : {}
  const rows: SubscriptionQuotaRow[] = []
  const fiveHour = commandCodeWindowRow('5小时', limits['fiveHour'])
  if (fiveHour !== null) rows.push(fiveHour)
  const weekly = commandCodeWindowRow('每周', limits['weekly'])
  if (weekly !== null) rows.push(weekly)
  const monthly = commandCodeMonthlyRow(creditsPayload, subscriptionsPayload)
  if (monthly !== null) rows.push(monthly)
  if (rows.length === 0) return null
  const [summary, ...rest] = rows
  return { summary: summary ?? null, limits: rest, extraUsage: null }
}

function commandCodeWindowRow(name: string, raw: unknown): SubscriptionQuotaRow | null {
  if (!isRecord(raw)) return null
  const limit = finiteNumber(raw['cap'])
  if (limit === null || limit <= 0) return null
  return {
    name,
    used: Math.max(0, finiteNumber(raw['used']) ?? 0),
    limit,
    resetAt: isoTimestamp(raw['resetAt']),
  }
}

/** 套餐未知时宁可不显示每月行，也不把「未知总额」画成「未使用」。 */
function commandCodeMonthlyRow(
  creditsPayload: Record<string, unknown>,
  subscriptionsPayload: unknown,
): SubscriptionQuotaRow | null {
  const credits = creditsPayload['credits']
  if (!isRecord(credits)) return null
  const remaining = finiteNumber(credits['monthlyCredits'])
  if (remaining === null) return null
  const subscription = commandCodeSubscription(subscriptionsPayload)
  if (subscription === null) return null
  const plan = COMMAND_CODE_PLANS.find((candidate) => candidate.id === subscription.planId)
  if (plan === undefined) return null
  return {
    name: '每月',
    used: Math.max(0, plan.monthlyCredits - Math.max(0, remaining)),
    limit: plan.monthlyCredits,
    resetAt: subscription.currentPeriodEnd,
  }
}

function commandCodeSubscription(
  payload: unknown,
): { readonly planId: string; readonly currentPeriodEnd: string | undefined } | null {
  if (!isRecord(payload) || payload['success'] !== true) return null
  const data = payload['data']
  if (!isRecord(data)) return null
  const planId = text(data['planId'])?.toLowerCase()
  if (planId === undefined) return null
  return { planId, currentPeriodEnd: isoTimestamp(data['currentPeriodEnd']) }
}

/** 账单接口的重置时间是 epoch 毫秒，快照其余部分按 ISO 字符串处理。 */
function isoTimestamp(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const date = new Date(raw > 10_000_000_000 ? raw : raw * 1000)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return text(raw)
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
