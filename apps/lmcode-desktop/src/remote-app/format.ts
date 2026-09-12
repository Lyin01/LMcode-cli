import type { ApprovalRequest } from '@lmcode-cli/lmcode-sdk'

/** Last path segment, tolerant of Windows and POSIX separators. */
export function basename(input: string): string {
  const segments = input.trim().split(/[\\/]+/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? input
}

export function relativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const elapsedMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** One-line preview of a tool result, collapsed like the desktop transcript. */
export function summarizeOutput(output: unknown): string | undefined {
  let text: string
  if (typeof output === 'string') {
    text = output
  } else if (output === undefined || output === null) {
    return undefined
  } else {
    try {
      text = JSON.stringify(output) ?? ''
    } catch {
      return undefined
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return undefined
  return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized
}

interface DisplayLike {
  readonly kind?: string
  readonly command?: string
  readonly cwd?: string
  readonly description?: string
  readonly operation?: string
  readonly path?: string
  readonly detail?: unknown
  readonly query?: string
  readonly scope?: string
  readonly url?: string
  readonly method?: string
  readonly agent_name?: string
  readonly prompt?: string
  readonly skill_name?: string
  readonly args?: string
  readonly items?: readonly unknown[]
  readonly task_id?: string
  readonly task_description?: string
  readonly summary?: string
  readonly plan?: string
  readonly hunks?: number
}

/** Human-readable lines describing what an approval request wants to run. */
export function describeApproval(rawDisplay: ApprovalRequest['display']): string[] {
  // The display union is managed by the SDK; read it field-wise so unknown
  // kinds still render something useful instead of breaking the sheet.
  const display = rawDisplay as DisplayLike
  const lines: string[] = []
  switch (display.kind) {
    case 'command':
      lines.push(`$ ${display.command ?? ''}`)
      if (display.cwd !== undefined && display.cwd.length > 0) lines.push(`目录：${display.cwd}`)
      if (display.description !== undefined && display.description.length > 0) {
        lines.push(display.description)
      }
      break
    case 'file_io':
      lines.push(`${operationLabel(display.operation)} ${display.path ?? ''}`)
      if (typeof display.detail === 'string' && display.detail.length > 0) lines.push(display.detail)
      break
    case 'diff':
      lines.push(
        `修改 ${display.path ?? ''}${typeof display.hunks === 'number' ? `（${display.hunks} 处改动）` : ''}`,
      )
      break
    case 'search':
      lines.push(`搜索 ${display.query ?? ''}${display.scope === undefined ? '' : `（范围：${display.scope}）`}`)
      break
    case 'url_fetch':
      lines.push(`请求 ${display.method ?? 'GET'} ${display.url ?? ''}`)
      break
    case 'agent_call':
      lines.push(`调用子 Agent ${display.agent_name ?? ''}`)
      if (display.prompt !== undefined && display.prompt.length > 0) lines.push(clip(display.prompt))
      break
    case 'skill_call':
      lines.push(`运行技能 ${display.skill_name ?? ''}`)
      if (display.args !== undefined && display.args.length > 0) lines.push(display.args)
      break
    case 'todo_list':
      lines.push(`更新待办（${display.items?.length ?? 0} 项）`)
      break
    case 'background_task':
      lines.push(`后台任务 ${display.task_id ?? ''} · ${display.description ?? ''}`)
      break
    case 'task_stop':
      lines.push(`停止后台任务 ${display.task_id ?? ''} · ${display.task_description ?? ''}`)
      break
    case 'plan_review':
      lines.push('请求审阅计划')
      if (display.plan !== undefined && display.plan.length > 0) lines.push(clip(display.plan))
      break
    default:
      lines.push(clip(JSON.stringify(rawDisplay) ?? String(display.kind ?? '工具调用')))
  }
  return lines.filter((line) => line.length > 0)
}

function operationLabel(operation: string | undefined): string {
  switch (operation) {
    case 'read':
      return '读取'
    case 'write':
      return '写入'
    case 'edit':
      return '编辑'
    case 'glob':
      return '查找文件'
    case 'grep':
      return '搜索内容'
    default:
      return operation ?? '访问'
  }
}

function clip(text: string, max = 400): string {
  const normalized = text.trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}
