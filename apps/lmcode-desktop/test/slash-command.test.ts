import { describe, expect, it } from 'vitest'
import {
  buildDesktopReviewPrompt,
  filterSlashCommands,
  parseDesktopSlashCommand,
  shouldHandleSlashKeys,
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

describe('slash command filtering for the composer dialog', () => {
  const commands = [
    { id: 'goal', label: '/goal', description: '创建目标并立即开始执行' },
    { id: 'help', label: '/help', description: '显示帮助' },
  ]

  it('lists every command for an empty query', () => {
    expect(filterSlashCommands(commands, '')).toHaveLength(2)
  })

  it('matches by id, label, or description', () => {
    expect(filterSlashCommands(commands, 'go')).toEqual([commands[0]])
    expect(filterSlashCommands(commands, '/hel')).toEqual([commands[1]])
    expect(filterSlashCommands(commands, '帮助')).toEqual([commands[1]])
  })

  it('returns zero matches for an unknown command', () => {
    expect(filterSlashCommands(commands, 'zzz')).toHaveLength(0)
  })
})

describe('shouldHandleSlashKeys', () => {
  it('lets Enter/arrows/Tab through when nothing matches the query', () => {
    // Regression: with zero matches the dialog renders nothing, so Composer
    // must not swallow the keys — otherwise Enter is a dead key.
    expect(shouldHandleSlashKeys(true, 0)).toBe(false)
  })

  it('intercepts navigation keys while matches are visible', () => {
    expect(shouldHandleSlashKeys(true, 3)).toBe(true)
  })

  it('ignores keys when the dialog is closed', () => {
    expect(shouldHandleSlashKeys(false, 3)).toBe(false)
    expect(shouldHandleSlashKeys(false, 0)).toBe(false)
  })
})
