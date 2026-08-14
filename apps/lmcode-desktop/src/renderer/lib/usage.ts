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

export type ContextPressureLevel = 'normal' | 'warning' | 'critical'

export interface ContextPressure {
  level: ContextPressureLevel
  percentage: number
  remainingTokens: number
  isNearLimit: boolean
  color: string
  bgClass: string
}

/**
 * Evaluates token context pressure based on deepseek-harness token-meter threshold model.
 * Level thresholds:
 *   - Normal: < 70%
 *   - Warning: 70% - 90% (triggers yellow badge and compact suggestion)
 *   - Critical: >= 90% (triggers red warning and urgent compact suggestion)
 */
export function evaluateContextPressure(currentTokens: number, maxTokens: number): ContextPressure {
  if (maxTokens <= 0) {
    return {
      level: 'normal',
      percentage: 0,
      remainingTokens: 0,
      isNearLimit: false,
      color: 'var(--lm-accent)',
      bgClass: 'bg-[var(--lm-accent)]',
    }
  }

  const percentage = Math.min(100, Math.max(0, (currentTokens / maxTokens) * 100))
  const remainingTokens = Math.max(0, maxTokens - currentTokens)

  if (percentage >= 90) {
    return {
      level: 'critical',
      percentage,
      remainingTokens,
      isNearLimit: true,
      color: 'var(--lm-error)',
      bgClass: 'bg-[var(--lm-error)]',
    }
  }

  if (percentage >= 70) {
    return {
      level: 'warning',
      percentage,
      remainingTokens,
      isNearLimit: true,
      color: 'var(--lm-warning)',
      bgClass: 'bg-[var(--lm-warning)]',
    }
  }

  return {
    level: 'normal',
    percentage,
    remainingTokens,
    isNearLimit: false,
    color: 'var(--lm-accent)',
    bgClass: 'bg-[var(--lm-accent)]',
  }
}
