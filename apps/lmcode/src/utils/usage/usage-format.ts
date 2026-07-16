/**
 * Usage formatting and ratio helpers shared by `/usage` and the footer.
 *
 * Kept pure + ANSI-free so they're trivial to unit-test; the slash
 * Renderers apply colour afterwards.
 */

import type { TokenUsage } from '@lmcode-cli/lmcode-sdk';

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Return the share of input tokens served from the provider prompt cache.
 * `null` means that no input usage has been recorded yet; a real cache miss
 * remains distinguishable as `0`.
 */
export function promptCacheHitRatio(usage: TokenUsage | undefined): number | null {
  if (usage === undefined) return null;
  const cacheRead = tokenCount(usage.inputCacheRead);
  const totalInput =
    tokenCount(usage.inputOther) + cacheRead + tokenCount(usage.inputCacheCreation);
  if (totalInput === 0) return null;
  return cacheRead / totalInput;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Build a `[███░░░░░░░]` style bar. Returns a plain-ASCII string with
 * `filled`/`empty` glyphs — colouring is the caller's responsibility.
 */
export function renderProgressBar(ratio: number, width = 20, filled = '█', empty = '░'): string {
  const clamped = safeUsageRatio(ratio);
  const filledCount = Math.round(clamped * width);
  return filled.repeat(filledCount) + empty.repeat(Math.max(0, width - filledCount));
}

export function safeUsageRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
}

/**
 * Map a usage ratio to a semantic colour token — the `/usage` renderer
 * translates these into palette hex values.
 */
export function ratioSeverity(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.85) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}
