import { describe, expect, it } from 'vitest'
import {
  buildDesktopReviewPrompt,
  parseDesktopSlashCommand,
} from '../src/renderer/lib/slash-command'

describe('desktop slash command parsing', () => {
  it('keeps normal prompts out of command dispatch', () => {
    expect(parseDesktopSlashCommand('explain /goal behavior')).toBeNull()
  })

  it('parses goal lifecycle commands without losing reserved objective prefixes', () => {
    expect(parseDesktopSlashCommand('/goal ship the desktop')).toEqual({
      kind: 'goal-create',
      objective: 'ship the desktop',
      replace: false,
    })
    expect(parseDesktopSlashCommand('/goal replace close parity gaps')).toEqual({
      kind: 'goal-create',
      objective: 'close parity gaps',
      replace: true,
    })
    expect(parseDesktopSlashCommand('/goal -- pause safely')).toEqual({
      kind: 'goal-create',
      objective: 'pause safely',
      replace: false,
    })
    expect(parseDesktopSlashCommand('/goal pause')).toEqual({ kind: 'goal-pause' })
    expect(parseDesktopSlashCommand('/goaloff')).toEqual({ kind: 'goal-cancel' })
  })

  it('validates plan and revoke arguments before IPC execution', () => {
    expect(parseDesktopSlashCommand('/plan')).toEqual({ kind: 'plan', enabled: true })
    expect(parseDesktopSlashCommand('/plan off')).toEqual({ kind: 'plan', enabled: false })
    expect(parseDesktopSlashCommand('/revoke 3')).toEqual({ kind: 'revoke', count: 3 })
    expect(parseDesktopSlashCommand('/revoke zero')).toEqual(
      expect.objectContaining({ kind: 'error' }),
    )
  })

  it('parses visual and agent-driven review scopes with a read-only contract', () => {
    expect(parseDesktopSlashCommand('/review')).toEqual({ kind: 'review-open' })
    expect(parseDesktopSlashCommand('/review uncommitted')).toEqual({
      kind: 'review-run',
      target: 'uncommitted',
    })
    const base = parseDesktopSlashCommand('/review base origin/main')
    expect(base).toEqual({ kind: 'review-run', target: 'base', value: 'origin/main' })
    expect(parseDesktopSlashCommand('/review base --output=/tmp/leak')).toEqual(
      expect.objectContaining({ kind: 'error' }),
    )
    if (base?.kind !== 'review-run') throw new Error('expected a review command')
    expect(buildDesktopReviewPrompt(base)).toContain('不要修改工作区、暂存区或提交历史')
    expect(buildDesktopReviewPrompt(base)).toContain('`origin/main`')
  })
})
