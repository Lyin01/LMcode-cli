export type ParsedDesktopSlashCommand =
  | { readonly kind: 'goal-status' }
  | { readonly kind: 'goal-create'; readonly objective: string; readonly replace: boolean }
  | { readonly kind: 'goal-pause' }
  | { readonly kind: 'goal-resume' }
  | { readonly kind: 'goal-cancel' }
  | { readonly kind: 'plan'; readonly enabled: boolean }
  | { readonly kind: 'compact'; readonly instruction?: string }
  | { readonly kind: 'revoke'; readonly count: number }
  | { readonly kind: 'review-open' }
  | {
      readonly kind: 'review-run'
      readonly target: 'uncommitted' | 'base' | 'commit' | 'custom'
      readonly value?: string
    }
  | { readonly kind: 'model' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

export function parseDesktopSlashCommand(input: string): ParsedDesktopSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return { kind: 'error', message: '请输入完整的斜杠命令。' }

  const name = match[1]?.toLowerCase()
  const args = match[2]?.trim() ?? ''
  switch (name) {
    case 'goal':
      return parseGoalCommand(args)
    case 'plan':
      if (args === '' || args === 'on' || args === 'enter') return { kind: 'plan', enabled: true }
      if (args === 'off' || args === 'exit') return { kind: 'plan', enabled: false }
      return { kind: 'error', message: '用法：`/plan` 或 `/plan off`。' }
    case 'compact':
      return args ? { kind: 'compact', instruction: args } : { kind: 'compact' }
    case 'revoke': {
      if (args === '') return { kind: 'revoke', count: 1 }
      const count = Number(args)
      if (!Number.isSafeInteger(count) || count < 1) {
        return { kind: 'error', message: '用法：`/revoke [正整数]`。' }
      }
      return { kind: 'revoke', count }
    }
    case 'review':
      return parseReviewCommand(args)
    case 'model':
    case 'clear':
    case 'help':
      if (args) return { kind: 'error', message: `命令 \`/${name}\` 不接受参数。` }
      return { kind: name }
    default:
      return { kind: 'error', message: `未知命令：\`/${name ?? ''}\`。输入 \`/help\` 查看可用命令。` }
  }
}

function parseReviewCommand(args: string): ParsedDesktopSlashCommand {
  if (args === '') return { kind: 'review-open' }
  if (args === 'uncommitted') return { kind: 'review-run', target: 'uncommitted' }

  const separator = args.indexOf(' ')
  const target = separator < 0 ? args : args.slice(0, separator)
  const value = separator < 0 ? '' : args.slice(separator + 1).trim()
  if (target === 'custom') {
    if (!value) {
      return { kind: 'error', message: '用法：`/review custom <审查重点>`。' }
    }
    return { kind: 'review-run', target: 'custom', value }
  }
  if (target === 'base' || target === 'commit') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/.test(value)) {
      return {
        kind: 'error',
        message: `用法：\`/review ${target} <Git 引用>\`。`,
      }
    }
    return { kind: 'review-run', target, value }
  }
  return {
    kind: 'error',
    message: '用法：`/review`、`/review uncommitted`、`/review base <分支>`、`/review commit <引用>` 或 `/review custom <重点>`。',
  }
}

export function buildDesktopReviewPrompt(
  command: Extract<ParsedDesktopSlashCommand, { readonly kind: 'review-run' }>,
): string {
  const guardrail = '只进行只读代码审查，不要修改工作区、暂存区或提交历史。按严重程度列出可验证的问题，并提供文件与行号；如果没有明确问题，请直接说明。'
  switch (command.target) {
    case 'uncommitted':
      return `审查当前 Git 工作区中的所有未提交变更。${guardrail}`
    case 'base':
      return `以 Git 分支 \`${command.value}\` 为基线，审查当前分支相对它的变更。${guardrail}`
    case 'commit':
      return `审查 Git 提交 \`${command.value}\` 引入的变更。${guardrail}`
    case 'custom':
      return `审查当前 Git 工作区中的未提交变更，重点关注：${command.value}\n\n${guardrail}`
  }
}

function parseGoalCommand(args: string): ParsedDesktopSlashCommand {
  if (args === '' || args === 'status') return { kind: 'goal-status' }
  if (args === 'pause') return { kind: 'goal-pause' }
  if (args === 'resume') return { kind: 'goal-resume' }
  if (args === 'off') return { kind: 'goal-cancel' }

  const tokens = args.split(/\s+/)
  let index = 0
  let replace = false
  if (tokens[index] === 'replace') {
    replace = true
    index += 1
  }
  if (tokens[index] === '--') index += 1

  const objective = tokens.slice(index).join(' ').trim()
  if (!objective) {
    return { kind: 'error', message: '请提供目标描述，例如 `/goal 实现登录功能`。' }
  }
  return { kind: 'goal-create', objective, replace }
}

// ── Slash palette ──────────────────────────────────────────────────

/** Minimal shape needed to filter and render the slash palette. */
export interface SlashCommandLike {
  readonly id: string
  readonly label: string
  readonly description: string
}

/** Built-in commands ship with the app; skills are user/project extensions. */
export type SlashCommandSource = 'builtin' | 'skill'

/** One palette entry. Skills are exposed as `/skill-name` for discoverability. */
export interface SlashCandidate extends SlashCommandLike {
  readonly source: SlashCommandSource
  /** Text written into the composer on Enter when the command needs an argument. */
  readonly insertText?: string
  /** Skill name to activate; only meaningful when `source` is `skill`. */
  readonly skillName?: string
}

/**
 * Built-in command catalogue. Kept in the lib layer so the composer and the
 * palette share one source of truth and tests can cover the accept semantics
 * without mounting React.
 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCandidate[] = [
  {
    id: 'goal',
    label: '/goal',
    description: '创建目标并立即开始执行',
    source: 'builtin',
    insertText: '/goal ',
  },
  { id: 'plan', label: '/plan', description: '进入只读规划模式', source: 'builtin' },
  {
    id: 'review',
    label: '/review',
    description: '打开代码审查，或指定范围让 Agent 只读审查',
    source: 'builtin',
  },
  { id: 'model', label: '/model', description: '切换模型', source: 'builtin' },
  { id: 'compact', label: '/compact', description: '压缩当前会话上下文', source: 'builtin' },
  { id: 'revoke', label: '/revoke', description: '撤销最近一轮对话', source: 'builtin' },
  { id: 'clear', label: '/clear', description: '在当前项目中新建对话', source: 'builtin' },
  { id: 'help', label: '/help', description: '显示帮助', source: 'builtin' },
]

export type SlashPaletteState =
  | { readonly open: false }
  | { readonly open: true; readonly query: string; readonly token: string }

const CLOSED_PALETTE: SlashPaletteState = { open: false }

/**
 * Whether the palette should be visible for the composer's current text.
 *
 * Claude-style trigger: the message must start with `/` and the caret must sit
 * inside the command token. A space ends the token (the caret moves into the
 * argument area) and closes the palette, so `/goal finish the port` never
 * fights the user over the objective text.
 *
 * `dismissedToken` is the token the user escaped out of: the same token stays
 * closed until the text changes again, so Escape is not immediately undone by
 * the next keystroke of the same word.
 */
export function resolveSlashPalette(
  value: string,
  caret: number,
  dismissedToken: string | null,
): SlashPaletteState {
  if (caret < 1) return CLOSED_PALETTE
  const tokenEnd = value.search(/\s/)
  const token = tokenEnd < 0 ? value : value.slice(0, tokenEnd)
  if (!token.startsWith('/')) return CLOSED_PALETTE
  if (caret > token.length) return CLOSED_PALETTE
  if (dismissedToken === token) return CLOSED_PALETTE
  return { open: true, query: token.slice(1), token }
}

/**
 * Filters and ranks candidates for the palette query.
 *
 * Prefix matches on the command name outrank substring matches, which outrank
 * description matches; ties keep the catalogue order so the list is stable
 * while the user types.
 */
export function rankSlashCommands<T extends SlashCommandLike>(
  commands: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().replace(/^\//, '').toLowerCase()
  if (!needle) return [...commands]

  const scored: Array<{ command: T; score: number; index: number }> = []
  commands.forEach((command, index) => {
    const id = command.id.toLowerCase()
    const label = command.label.replace(/^\//, '').toLowerCase()
    const description = command.description.toLowerCase()
    let score = 0
    if (id === needle || label === needle) score = 4
    else if (id.startsWith(needle) || label.startsWith(needle)) score = 3
    else if (id.includes(needle) || label.includes(needle)) score = 2
    else if (description.includes(needle)) score = 1
    if (score > 0) scored.push({ command, score, index })
  })

  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((entry) => entry.command)
}

/**
 * Filters the command list for the slash palette. Kept under the original name
 * because the composer uses it for the match count that decides whether
 * navigation keys belong to the palette.
 */
export function filterSlashCommands<T extends SlashCommandLike>(
  commands: readonly T[],
  query: string,
): T[] {
  return rankSlashCommands(commands, query)
}

/** `/name ` — the text Tab writes into the composer. */
export function slashCommandText(candidate: SlashCommandLike): string {
  const name = candidate.label.startsWith('/') ? candidate.label.slice(1) : candidate.label
  return `/${name} `
}

export type SlashAcceptMode = 'complete' | 'run'

export type SlashAcceptAction =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'run'; readonly command: string }
  | { readonly kind: 'skill'; readonly name: string }

/**
 * What accepting the highlighted entry does.
 *
 * - Tab (`complete`) always writes `/name ` and keeps the caret in the composer.
 * - Enter (`run`) executes argument-free commands immediately, but inserts text
 *   for commands that need an argument (`/goal`) instead of running a bare one.
 * - Skills run through `activateSkill`, not the slash parser.
 */
export function resolveSlashAccept(
  candidate: SlashCandidate,
  mode: SlashAcceptMode,
): SlashAcceptAction {
  if (candidate.source === 'skill') {
    return { kind: 'skill', name: candidate.skillName ?? candidate.id.replace(/^skill:/, '') }
  }
  if (mode === 'complete') return { kind: 'complete', text: slashCommandText(candidate) }
  if (candidate.insertText) return { kind: 'complete', text: candidate.insertText }
  return { kind: 'run', command: candidate.label }
}

/**
 * Whether the composer may intercept Enter/ArrowUp/ArrowDown/Tab on behalf of
 * the slash palette. With zero matches the palette renders only a hint, so the
 * keys must fall through to the textarea — otherwise Enter becomes a dead key.
 */
export function shouldHandleSlashKeys(showSlash: boolean, matchCount: number): boolean {
  return showSlash && matchCount > 0
}

/** Clamps the highlighted index after the query narrows the list. */
export function clampSlashIndex(index: number, matchCount: number): number {
  if (matchCount <= 0) return 0
  return Math.min(Math.max(index, 0), matchCount - 1)
}

/** Wraps the highlight so ArrowDown on the last entry returns to the first. */
export function moveSlashIndex(index: number, delta: number, matchCount: number): number {
  if (matchCount <= 0) return 0
  return ((index + delta) % matchCount + matchCount) % matchCount
}

const STREAMING_BLOCKED_SLASH = new Set<ParsedDesktopSlashCommand['kind']>([
  'goal-create',
  'goal-resume',
  'plan',
  'compact',
  'revoke',
  'clear',
  'review-run',
])

/** Compact / revoke / new turns must not run on top of an in-flight generation. */
export function slashCommandBlockedWhileStreaming(
  kind: ParsedDesktopSlashCommand['kind'],
): boolean {
  return STREAMING_BLOCKED_SLASH.has(kind)
}
