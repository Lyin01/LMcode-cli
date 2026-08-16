export type ProviderUsageKind = 'api-balance' | 'subscription-quota' | 'opencode-go'

export interface ProviderMoneyBalance {
  readonly currency: string
  readonly available: number
  readonly cash?: number
  readonly bonus?: number
}

export interface ProviderApiBalance {
  readonly providerId: string
  readonly balances: readonly ProviderMoneyBalance[]
}

export interface SubscriptionQuotaWindow {
  readonly duration: number
  readonly unit: 'minute' | 'hour' | 'day' | 'week'
}

export interface SubscriptionQuotaRow {
  readonly name?: string
  readonly window?: SubscriptionQuotaWindow
  readonly used: number
  readonly limit: number
  readonly resetAt?: string
}

export interface SubscriptionExtraUsage {
  readonly balanceCents: number
  readonly totalCents: number
  readonly currency: string
}

export interface ProviderSubscriptionQuota {
  readonly providerId: string
  readonly summary: SubscriptionQuotaRow | null
  readonly limits: readonly SubscriptionQuotaRow[]
  readonly extraUsage: SubscriptionExtraUsage | null
}

export interface ProviderUsageIssue {
  readonly providerId: string
  readonly kind: ProviderUsageKind
  readonly message: string
}

export interface ProviderUsageSnapshot {
  readonly apiBalances: readonly ProviderApiBalance[]
  readonly subscriptions: readonly ProviderSubscriptionQuota[]
  readonly issues: readonly ProviderUsageIssue[]
  readonly fetchedAt: number
}
