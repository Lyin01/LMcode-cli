import type { UsageStatus } from '@lmcode-cli/lmcode-sdk'

import type { TokenUsageSummary } from '@/types'

/**
 * Flatten the SDK's per-model/turn usage into a single aggregate for the
 * context meter. `UsageStatus.total` is the session-wide TokenUsage; when the
 * harness has not accrued any usage yet the total is absent and we report
 * nothing rather than a fabricated zero breakdown.
 */
export function summarizeUsage(usage: UsageStatus | undefined): TokenUsageSummary | undefined {
  const total = usage?.total
  if (!total) return undefined
  return {
    inputTokens: total.inputOther + total.inputCacheRead + total.inputCacheCreation,
    outputTokens: total.output,
    cacheReadTokens: total.inputCacheRead,
    cacheWriteTokens: total.inputCacheCreation,
  }
}
