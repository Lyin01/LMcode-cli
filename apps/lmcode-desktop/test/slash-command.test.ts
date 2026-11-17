import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SLASH_COMMANDS,
  buildDesktopReviewPrompt,
  clampSlashIndex,
  filterSlashCommands,
  moveSlashIndex,
  parseDesktopSlashCommand,
  rankSlashCommands,
  resolveSlashAccept,
  resolveSlashPalette,
  shouldHandleSlashKeys,
  slashCommandBlockedWhileStreaming,
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
    expect(parseDesktopSlashCommand('/goal off')).toEqual({ kind: 'goal-cancel' })
    expect(parseDesktopSlashCommand('/goaloff')).toEqual(
      expect.objectContaining({ kind: 'error' }),
    )
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

describe('slash commands while a turn is streaming', () => {
  it('blocks compact, revoke, and new-turn commands until generation stops', () => {
    expect(slashCommandBlockedWhileStreaming('compact')).toBe(true)
    expect(slashCommandBlockedWhileStreaming('revoke')).toBe(true)
    expect(slashCommandBlockedWhileStreaming('goal-create')).toBe(true)
    expect(slashCommandBlockedWhileStreaming('review-run')).toBe(true)
    expect(slashCommandBlockedWhileStreaming('clear')).toBe(true)
  })

  it('still allows help, status, and panel-opening commands', () => {
    expect(slashCommandBlockedWhileStreaming('help')).toBe(false)
    expect(slashCommandBlockedWhileStreaming('goal-status')).toBe(false)
    expect(slashCommandBlockedWhileStreaming('review-open')).toBe(false)
    expect(slashCommandBlockedWhileStreaming('model')).toBe(false)
  })
})

describe('command catalogue', () => {
  it('drops low-frequency commands from both the palette and the parser', () => {
    for (const name of ['dream', 'export', 'goaloff', 'mode', 'config']) {
      expect(BUILTIN_SLASH_COMMANDS.some((command) => command.id === name)).toBe(false)
      expect(parseDesktopSlashCommand(`/${name}`)).toEqual(
        expect.objectContaining({ kind: 'error' }),
      )
    }
    // `/goal off` survives as the single way to cancel a goal.
    expect(parseDesktopSlashCommand('/goal off')).toEqual({ kind: 'goal-cancel' })
  })

  it('keeps the eight commands that earn their slot', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.id)).toEqual([
      'goal',
      'plan',
      'review',
      'model',
      'compact',
      'revoke',
      'clear',
      'help',
    ])
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

describe('slash palette trigger', () => {
  it('opens as soon as the message starts with "/" and narrows with the query', () => {
    expect(resolveSlashPalette('/', 1, null)).toEqual({ open: true, query: '', token: '/' })
    expect(resolveSlashPalette('/go', 3, null)).toEqual({ open: true, query: 'go', token: '/go' })
  })

  it('closes once the caret leaves the command token for the argument area', () => {
    // Pasting a full command must not reopen the palette over the objective.
    expect(resolveSlashPalette('/goal 实现登录', 10, null)).toEqual({ open: false })
    expect(resolveSlashPalette('/goal ', 6, null)).toEqual({ open: false })
  })

  it('only triggers on a leading slash', () => {
    expect(resolveSlashPalette('请在 /goal 里说明', 8, null)).toEqual({ open: false })
    expect(resolveSlashPalette('', 0, null)).toEqual({ open: false })
    expect(resolveSlashPalette('/', 0, null)).toEqual({ open: false })
  })

  it('keeps an escaped token closed until the text changes', () => {
    expect(resolveSlashPalette('/go', 3, '/go')).toEqual({ open: false })
    expect(resolveSlashPalette('/gol', 4, '/go')).toEqual({
      open: true,
      query: 'gol',
      token: '/gol',
    })
  })
})

describe('slash palette ranking', () => {
  // Synthetic names: this exercises the ranking algorithm, not the shipped
  // catalogue, so it must not imply a removed command still exists.
  const commands = [
    { id: 'goallong', label: '/goallong', description: '较长的前缀命令' },
    { id: 'goal', label: '/goal', description: '创建目标并立即开始执行' },
    { id: 'review', label: '/review', description: '打开代码审查，或指定范围让 Agent 只读审查' },
  ]

  it('puts an exact command name ahead of longer prefixes', () => {
    expect(rankSlashCommands(commands, 'goal').map((command) => command.id)).toEqual([
      'goal',
      'goallong',
    ])
  })

  it('matches a description when no command name matches', () => {
    expect(rankSlashCommands(commands, '代码审查').map((command) => command.id)).toEqual(['review'])
  })

  it('serves the palette and the composer from the same filtered list', () => {
    expect(filterSlashCommands(commands, 'go')).toEqual(rankSlashCommands(commands, 'go'))
    expect(filterSlashCommands(commands, 'zzz')).toEqual([])
  })
})

describe('slash palette accept semantics', () => {
  const goal = BUILTIN_SLASH_COMMANDS.find((command) => command.id === 'goal')
  const help = BUILTIN_SLASH_COMMANDS.find((command) => command.id === 'help')
  if (!goal || !help) throw new Error('built-in slash command catalogue is incomplete')
  const skill = {
    id: 'skill:dream-report',
    label: '/dream-report',
    description: '整理记忆库',
    source: 'skill' as const,
    skillName: 'dream-report',
  }

  it('Tab completes the highlighted command and leaves room for an argument', () => {
    expect(resolveSlashAccept(help, 'complete')).toEqual({ kind: 'complete', text: '/help ' })
  })

  it('Enter runs argument-free commands immediately', () => {
    expect(resolveSlashAccept(help, 'run')).toEqual({ kind: 'run', command: '/help' })
  })

  it('Enter inserts commands that need an argument instead of running a bare one', () => {
    expect(resolveSlashAccept(goal, 'run')).toEqual({ kind: 'complete', text: '/goal ' })
  })

  it('routes skill entries through activateSkill for both keys', () => {
    expect(resolveSlashAccept(skill, 'run')).toEqual({ kind: 'skill', name: 'dream-report' })
    expect(resolveSlashAccept(skill, 'complete')).toEqual({ kind: 'skill', name: 'dream-report' })
  })
})

describe('slash palette highlight', () => {
  it('wraps the highlight in both directions', () => {
    expect(moveSlashIndex(2, 1, 3)).toBe(0)
    expect(moveSlashIndex(0, -1, 3)).toBe(2)
    expect(moveSlashIndex(0, 1, 0)).toBe(0)
  })

  it('clamps a stale index after the query narrows the list', () => {
    expect(clampSlashIndex(9, 2)).toBe(1)
    expect(clampSlashIndex(-3, 2)).toBe(0)
    expect(clampSlashIndex(3, 0)).toBe(0)
  })
})
