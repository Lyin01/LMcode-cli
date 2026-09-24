import { describe, expect, it } from 'vitest'
import type { CompactSessionOutcome } from '../src/shared/ipc-types'
import { compactionNotice } from '../src/renderer/lib/compaction-notice'

describe('compaction notice text', () => {
  it('states the real elapsed time and reduction for a completed compaction', () => {
    const outcome: CompactSessionOutcome = {
      outcome: 'completed',
      compactedCount: 12,
      tokensBefore: 466_000,
      tokensAfter: 88_000,
      elapsedMs: 192_000,
    }

    expect(compactionNotice(outcome)).toEqual({
      content: '上下文压缩完成（压缩 12 条消息，约 466k → 88k tokens，用时 3m 12s）。',
      variant: 'notice',
    })
  })

  it('keeps cancellation neutral, with the reason when one is reported', () => {
    expect(
      compactionNotice({ outcome: 'cancelled', elapsedMs: 5_000 }),
    ).toEqual({ content: '上下文压缩已取消。', variant: 'notice' })

    expect(
      compactionNotice({
        outcome: 'cancelled',
        reason: '目标预算已用尽，压缩已取消。',
        elapsedMs: 5_000,
      }),
    ).toEqual({
      content: '上下文压缩已取消：目标预算已用尽，压缩已取消。',
      variant: 'notice',
    })
  })

  it('surfaces a failed compaction as an error notice', () => {
    expect(compactionNotice({ outcome: 'failed', message: 'boom', elapsedMs: 1_000 })).toEqual({
      content: '上下文压缩失败：boom',
      variant: 'error',
    })
  })

  it('never claims completion when the wait timed out', () => {
    expect(compactionNotice({ outcome: 'pending', elapsedMs: 900_000 })).toEqual({
      content: '压缩仍在进行中，完成后上下文用量会自动更新。',
      variant: 'notice',
    })
  })
})
