import type {
  ProviderMoneyBalance,
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

export interface OpenCodeQuotaMeter {
  readonly label: string
  readonly remainingPercent: number | null
  readonly remaining: number
  readonly limit: number
  readonly resetAt?: string
}

export interface OpenCodeUsageDisplay {
  readonly providerId: string
  readonly meters: readonly OpenCodeQuotaMeter[]
  readonly issue: string | null
}

const OPENCODE_PROVIDER_PATTERN = /open[\s_-]?code/i
const OPENCODE_WINDOW_LABELS = new Set(['滚动', '每周', '每月'])

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
): OpenCodeUsageDisplay | null {
  const issue = snapshot.issues.find(
    (candidate) =>
      candidate.kind === 'opencode-go' || OPENCODE_PROVIDER_PATTERN.test(candidate.providerId),
  )
  const subscription = snapshot.subscriptions.find((candidate) =>
    OPENCODE_PROVIDER_PATTERN.test(candidate.providerId),
  ) ?? snapshot.subscriptions.find((candidate) => {
    const rows = candidate.summary === null
      ? candidate.limits
      : [candidate.summary, ...candidate.limits]
    return rows.some((row) => row.name !== undefined && OPENCODE_WINDOW_LABELS.has(row.name))
  })

  if (subscription === undefined) {
    return issue === undefined
      ? null
      : { providerId: issue.providerId, meters: [], issue: issue.message }
  }

  const rows = subscription.summary === null
    ? subscription.limits
    : [subscription.summary, ...subscription.limits]
  const meters = rows
    .map((row): OpenCodeQuotaMeter => ({
      label: row.name?.trim() || quotaWindowLabel(row.window, undefined).trim(),
      remainingPercent: remainingQuotaPercent(row),
      remaining: Math.max(0, row.limit - row.used),
      limit: row.limit,
      resetAt: row.resetAt,
    }))
    .toSorted((left, right) => openCodeWindowOrder(left.label) - openCodeWindowOrder(right.label))

  return {
    providerId: subscription.providerId,
    meters,
    issue: issue?.message ?? null,
  }
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

function openCodeWindowOrder(label: string): number {
  switch (label) {
    case '滚动':
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
