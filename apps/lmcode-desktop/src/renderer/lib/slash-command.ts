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
  | { readonly kind: 'mode' }
  | { readonly kind: 'config' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'export' }
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
    case 'goaloff':
      return { kind: 'goal-cancel' }
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
    case 'mode':
    case 'config':
    case 'clear':
    case 'export':
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
