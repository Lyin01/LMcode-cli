import { describe, expect, it } from 'vitest'
import { parseDesktopSlashCommand } from '../src/renderer/lib/slash-command'

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
})
