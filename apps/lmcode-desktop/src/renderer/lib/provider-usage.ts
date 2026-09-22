import type {
  ProviderMoneyBalance,
  ProviderSubscriptionQuota,
  ProviderUsageKind,
  ProviderUsageSnapshot,
  SubscriptionQuotaRow,
  SubscriptionQuotaWindow,
} from '../../shared/provider-usage-types'

export interface ProviderUsageDisplay {
  readonly apiText: string
  readonly subscriptionText: string
  readonly title: string
  readonly hasIssues: boolean
  readonly apiHasIssues: boolean
  readonly subscriptionHasIssues: boolean
}

export interface QuotaMeter {
  readonly label: string
  readonly remainingPercent: number | null
  readonly remaining: number
  readonly limit: number
  readonly resetAt?: string
  /** 剩余/上限是美元金额（如 Command Code 的滚动窗口），而不是百分比计数。 */
  readonly money?: boolean
}

export interface QuotaUsageDisplay {
  readonly providerId: string
  readonly meters: readonly QuotaMeter[]
  readonly issue: string | null
}

interface QuotaDisplaySelector {
  readonly issueKinds: readonly ProviderUsageKind[]
  readonly providerPattern: RegExp
  readonly windowLabels: ReadonlySet<string>
  readonly money: boolean
}

const OPENCODE_PROVIDER_PATTERN = /open[\s_-]?code/i
const OPENCODE_WINDOW_LABELS = new Set(['滚动', '每周', '每月'])
const COMMANDCODE_PROVIDER_PATTERN = /command[\s_-]?code/i
const COMMANDCODE_WINDOW_LABELS = new Set(['5小时', '每周', '每月'])

export function remainingQuotaPercent(row: SubscriptionQuotaRow): number | null {
  if (row.limit <= 0) return null
  const remaining = Math.max(0, row.limit - row.used)
  return Math.min(100, Math.round((remaining / row.limit) * 100))
}

export function formatMoney(balance: ProviderMoneyBalance): string {
  const value = balance.available.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  switch (balance.currency) {
    case 'CNY':
      return `¥${value}`
    case 'USD':
      return `$${value}`
    case 'EUR':
      return `€${value}`
    default:
      return `${balance.currency} ${value}`
  }
}

export function buildProviderUsageDisplay(
  snapshot: ProviderUsageSnapshot,
): ProviderUsageDisplay {
  const apiIssues = snapshot.issues.filter((issue) => issue.kind === 'api-balance')
  const subscriptionIssues = snapshot.issues.filter((issue) => issue.kind !== 'api-balance')
  const apiValues = snapshot.apiBalances.flatMap((provider) =>
    provider.balances.map((balance) => `${provider.providerId} ${formatMoney(balance)}`),
  )
  const subscriptionValues = snapshot.subscriptions.flatMap((provider) => {
    const rows = provider.summary === null
      ? provider.limits
      : [provider.summary, ...provider.limits]
    const quotas = rows.map(formatQuotaRow)
    if (provider.extraUsage !== null) {
      quotas.push(`加油包 ${formatCents(provider.extraUsage.balanceCents, provider.extraUsage.currency)}`)
    }
    return quotas.length === 0
      ? []
      : [`${provider.providerId} ${quotas.join(' · ')}`]
  })
  const apiText = statusText('API 余额', apiValues, apiIssues.length > 0, '暂不支持')
  const subscriptionText = statusText(
    '订阅额度',
    subscriptionValues,
    subscriptionIssues.length > 0,
    '未配置',
  )
  const detailLines = [apiText, subscriptionText]
  for (const subscription of snapshot.subscriptions) {
    const rows = subscription.summary === null
      ? subscription.limits
      : [subscription.summary, ...subscription.limits]
    for (const row of rows) {
      detailLines.push(formatQuotaDetail(subscription.providerId, row))
    }
  }
  for (const issue of snapshot.issues) {
    detailLines.push(`${issue.providerId}：${issue.message}`)
  }

  return {
    apiText,
    subscriptionText,
    title: detailLines.join('\n'),
    hasIssues: snapshot.issues.length > 0,
    apiHasIssues: apiIssues.length > 0,
    subscriptionHasIssues: subscriptionIssues.length > 0,
  }
}

export function buildOpenCodeUsageDisplay(
  snapshot: ProviderUsageSnapshot,
): QuotaUsageDisplay | null {
  return buildQuotaUsageDisplay(snapshot, {
    issueKinds: ['opencode-go'],
    providerPattern: OPENCODE_PROVIDER_PATTERN,
    windowLabels: OPENCODE_WINDOW_LABELS,
    money: false,
  })
}

/** Command Code 的滚动窗口以美元额度计量，展示方式与 OpenCode Go 一致。 */
export function buildCommandCodeUsageDisplay(
  snapshot: ProviderUsageSnapshot,
): QuotaUsageDisplay | null {
  return buildQuotaUsageDisplay(snapshot, {
    issueKinds: ['command-code'],
    providerPattern: COMMANDCODE_PROVIDER_PATTERN,
    windowLabels: COMMANDCODE_WINDOW_LABELS,
    money: true,
  })
}

function buildQuotaUsageDisplay(
  snapshot: ProviderUsageSnapshot,
  selector: QuotaDisplaySelector,
): QuotaUsageDisplay | null {
  const issue = snapshot.issues.find(
    (candidate) =>
      selector.issueKinds.includes(candidate.kind) ||
      selector.providerPattern.test(candidate.providerId),
  )
  const subscription = snapshot.subscriptions.find((candidate) =>
    selector.providerPattern.test(candidate.providerId),
  ) ?? snapshot.subscriptions.find((candidate) =>
    subscriptionRows(candidate).some(
      (row) => row.name !== undefined && selector.windowLabels.has(row.name),
    ),
  )

  if (subscription === undefined) {
    return issue === undefined
      ? null
      : { providerId: issue.providerId, meters: [], issue: issue.message }
  }

  const meters = subscriptionRows(subscription)
    .map((row): QuotaMeter => ({
      label: row.name?.trim() || quotaWindowLabel(row.window, undefined).trim(),
      remainingPercent: remainingQuotaPercent(row),
      remaining: Math.max(0, row.limit - row.used),
      limit: row.limit,
      resetAt: row.resetAt,
      money: selector.money ? true : undefined,
    }))
    .toSorted((left, right) => quotaWindowOrder(left.label) - quotaWindowOrder(right.label))

  return {
    providerId: subscription.providerId,
    meters,
    issue: issue?.message ?? null,
  }
}

function subscriptionRows(
  subscription: ProviderSubscriptionQuota,
): readonly SubscriptionQuotaRow[] {
  return subscription.summary === null
    ? subscription.limits
    : [subscription.summary, ...subscription.limits]
}

function statusText(
  label: string,
  values: readonly string[],
  hasIssues: boolean,
  emptyText: string,
): string {
  if (values.length === 0) return `${label} · ${hasIssues ? '查询失败' : emptyText}`
  return `${label} · ${values.join(' / ')}${hasIssues ? '（部分失败）' : ''}`
}

function formatQuotaRow(row: SubscriptionQuotaRow): string {
  const percent = remainingQuotaPercent(row)
  return `${quotaWindowLabel(row.window, row.name)}剩余 ${percent === null ? '—' : `${String(percent)}%`}`
}

function formatQuotaDetail(providerId: string, row: SubscriptionQuotaRow): string {
  const remaining = Math.max(0, row.limit - row.used)
  const reset = row.resetAt === undefined ? '' : `，重置于 ${formatQuotaResetTime(row.resetAt)}`
  return `${providerId} ${quotaWindowLabel(row.window, row.name)}：剩余 ${String(remaining)} / ${String(row.limit)}${reset}`
}

function quotaWindowOrder(label: string): number {
  switch (label) {
    case '滚动':
    case '5小时':
      return 0
    case '每周':
      return 1
    case '每月':
      return 2
    default:
      return 3
  }
}

function quotaWindowLabel(
  window: SubscriptionQuotaWindow | undefined,
  fallback: string | undefined,
): string {
  if (window === undefined) return fallback === undefined ? '额度' : `${fallback} `
  if (window.duration === 1 && window.unit === 'week') return '周'
  const unit = {
    minute: '分钟',
    hour: '小时',
    day: '天',
    week: '周',
  }[window.unit]
  return `${String(window.duration)}${unit}`
}

function formatCents(cents: number, currency: string): string {
  return formatMoney({ currency, available: cents / 100 })
}

export function formatQuotaResetTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
