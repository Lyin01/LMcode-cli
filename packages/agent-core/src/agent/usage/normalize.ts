import type { TokenUsage } from '@lmcode-cli/ltod';

/**
 * Normalize a persisted or provider-supplied counter without allowing
 * malformed values to poison aggregate statistics or budgets.
 */
export function normalizeNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

export function normalizeTokenCount(value: number): number {
  return normalizeNonNegativeSafeInteger(value);
}

/**
 * Keep every field non-negative and integral while saturating the complete
 * response at Number.MAX_SAFE_INTEGER. Normal provider values pass through
 * unchanged; saturation only affects malformed or impossible counters.
 */
export function normalizeTokenUsage(usage: TokenUsage): TokenUsage {
  let remaining = Number.MAX_SAFE_INTEGER;
  const take = (value: number): number => {
    const normalized = normalizeTokenCount(value);
    const accepted = Math.min(normalized, remaining);
    remaining -= accepted;
    return accepted;
  };

  return {
    inputOther: take(usage.inputOther),
    output: take(usage.output),
    inputCacheRead: take(usage.inputCacheRead),
    inputCacheCreation: take(usage.inputCacheCreation),
  };
}
