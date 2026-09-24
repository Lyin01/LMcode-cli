import type { CompactSessionOutcome } from '../../shared/ipc-types'
import { formatRunElapsed } from '@/lib/run-status'

export interface CompactionNotice {
  readonly content: string
  readonly variant: 'notice' | 'error'
}

/**
 * Render a compaction outcome as the transcript notice shown to the user.
 * The wording must never claim a completion that did not happen — that is the
 * fix for `/compact` reporting “完成” the moment the begin-ack came back.
 */
export function compactionNotice(outcome: CompactSessionOutcome): CompactionNotice {
  switch (outcome.outcome) {
    case 'completed':
      return {
        content:
          '上下文压缩完成（' +
          `压缩 ${String(outcome.compactedCount)} 条消息，` +
          `约 ${formatTokenCount(outcome.tokensBefore)} → ${formatTokenCount(outcome.tokensAfter)} tokens，` +
          `用时 ${formatRunElapsed(outcome.elapsedMs)}）。`,
        variant: 'notice',
      }
    case 'cancelled':
      return {
        content:
          outcome.reason === undefined
            ? '上下文压缩已取消。'
            : `上下文压缩已取消：${outcome.reason}`,
        variant: 'notice',
      }
    case 'failed':
      return { content: `上下文压缩失败：${outcome.message}`, variant: 'error' }
    case 'pending':
      return { content: '压缩仍在进行中，完成后上下文用量会自动更新。', variant: 'notice' }
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${formatScaled(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${formatScaled(tokens / 1_000)}k`
  return String(tokens)
}

function formatScaled(value: number): string {
  if (value >= 100) return String(Math.round(value))
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}
