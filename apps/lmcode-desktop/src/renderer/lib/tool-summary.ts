/**
 * 工具调用的展示摘要：从参数和结果中提炼一句人类可读的短句。
 *
 * 折叠态的单行条目空间有限，参数摘要回答「要做什么」，结果摘要回答
 * 「做成了什么」（如 “128 行”、“3 个匹配”）。两者都以 ZCode 风格的
 * 「工具 · 摘要」形式呈现，避免整屏裸命令。
 */

interface ParsedArgs {
  readonly get: (keys: readonly string[]) => string | undefined
  readonly raw: Record<string, unknown> | null
}

/** 流式期间参数 JSON 可能只写了一半，尝试抽出第一个已完整的字符串键值。 */
function parsePartialArgs(argsRaw: string): Record<string, unknown> | null {
  const match = /"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsRaw)
  if (match === null) return null
  const value = match[2]!.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  return { [match[1]!]: value }
}

function parseArgs(argsRaw?: string): ParsedArgs {
  let raw: Record<string, unknown> | null = null
  if (argsRaw) {
    try {
      const parsed: unknown = JSON.parse(argsRaw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      raw = parsePartialArgs(argsRaw)
    }
  }
  return {
    raw,
    get: (keys) => {
      if (raw === null) return undefined
      for (const key of keys) {
        const value = raw[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      return undefined
    },
  }
}

function shortPath(path: string): string {
  const withoutDrive = path.replace(/^[a-zA-Z]:[/\\]/, '')
  const segments = withoutDrive.split(/[/\\]/)
  return segments.length > 1 ? segments.slice(-2).join('/') : withoutDrive
}

/** 截断长文本，保留首行并折叠连续空白。 */
function oneLine(text: string, max: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  const collapsed = line.replace(/\s+/g, ' ')
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** Bash 命令摘要：优先取最后一个管道/逻辑段的动词短语，去掉 cd 前缀噪声。 */
function summarizeCommand(command: string): string | undefined {
  const segments = command
    .split(/(?:&&|\|\||;|\n)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^cd\s/.test(s))
  const target = segments.at(-1) ?? command.trim()
  return oneLine(target, 48)
}

function countLines(text: string): number {
  return text.replace(/\n+$/, '').split('\n').length
}

/** 结果里形如 `path:line:` 或纯路径行的匹配计数（Grep/Glob 类结果）。 */
function countMatchLines(result: string): number | undefined {
  const lines = result
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\d+$/.test(l))
  const pathLike = lines.filter((l) => /^[\w./\\:-]+:\d/.test(l) || /[\w./\\-]+\/[\w./-]+/.test(l) || /^[a-zA-Z]:[\\/]/.test(l))
  if (pathLike.length === 0) return undefined
  return pathLike.length
}

export type ToolFamily =
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'todo'
  | 'agent'
  | 'web'
  | 'other'

/** 与 ToolCallBlock 的 classifyTool 保持同一套命名规则。 */
export function toolFamily(toolName: string, argsRaw?: string): ToolFamily {
  const name = (toolName || '').toLowerCase()
  // DeepSeek 锚定的 str_replace_editor 一个工具承担读/写/改三种语义，按 command 细分。
  if (name.includes('str_replace') || name.includes('replace_file')) {
    const command = parseArgs(argsRaw).get(['command'])
    if (command === 'view') return 'read'
    if (command === 'create') return 'write'
    return 'edit'
  }
  if (name.includes('command') || name.includes('bash') || name.includes('pwsh') || name.includes('terminal') || name.includes('exec')) {
    return 'bash'
  }
  if (name.includes('view_file') || name.includes('read_file') || name.includes('read_url') || name.startsWith('read')) return 'read'
  if (name.includes('write_to_file') || name.includes('write_file') || name.startsWith('write') || name.includes('create_file')) return 'write'
  if (name.includes('multi_replace') || name.includes('edit_file') || name.startsWith('edit')) return 'edit'
  if (name.includes('search') || name.includes('grep') || name.includes('list_dir') || name.includes('glob') || name.includes('find')) return 'search'
  if (name.includes('todo') || name.includes('task')) return 'todo'
  if (name.includes('subagent') || name.includes('agent') || name.includes('wolfpack')) return 'agent'
  if (name.includes('web') || name.includes('fetch') || name.includes('url')) return 'web'
  return 'other'
}

/** 运行中展示的参数摘要：「要做什么」。 */
export function summarizeToolArgs(toolName: string, argsRaw?: string): string | undefined {
  const family = toolFamily(toolName, argsRaw)
  const args = parseArgs(argsRaw)
  switch (family) {
    case 'bash': {
      const command = args.get(['CommandLine', 'command', 'cmd', 'script'])
      return command ? summarizeCommand(command) : undefined
    }
    case 'read': {
      const path = args.get(['AbsolutePath', 'TargetFile', 'path', 'filePath', 'Url', 'url'])
      const viewPath = args.get(['path'])
      return path ? shortPath(path) : viewPath ? shortPath(viewPath) : undefined
    }
    case 'write':
    case 'edit': {
      const path = args.get(['TargetFile', 'AbsolutePath', 'path', 'filePath'])
      return path ? shortPath(path) : undefined
    }
    case 'search': {
      const query = args.get(['Query', 'query', 'pattern'])
      const dir = args.get(['DirectoryPath', 'path'])
      const scope = dir ? ` @ ${shortPath(dir)}` : ''
      return query ? `"${oneLine(query, 32)}"${scope}` : dir ? shortPath(dir) : undefined
    }
    case 'todo': {
      const title = args.get(['Prompt', 'title', 'task', 'description'])
      return title ? oneLine(title, 36) : undefined
    }
    case 'agent': {
      const role = args.get(['Role', 'role', 'name'])
      const prompt = args.get(['Prompt', 'prompt', 'description'])
      return role ?? (prompt ? oneLine(prompt, 36) : undefined)
    }
    default: {
      if (args.raw === null) return undefined
      const first = Object.values(args.raw).find((v): v is string => typeof v === 'string' && v.trim().length > 0)
      return first ? oneLine(first, 40) : undefined
    }
  }
}

/** 工具调用的主文件路径（Read/Write/Edit 及 anchor 变体），供「打开文件」交互使用。 */
export function toolFilePath(toolName: string, argsRaw?: string): string | undefined {
  const family = toolFamily(toolName, argsRaw)
  if (family !== 'read' && family !== 'write' && family !== 'edit') return undefined
  const path = parseArgs(argsRaw).get(['path', 'file_path', 'TargetFile', 'AbsolutePath', 'filePath'])
  if (path === undefined) return undefined
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\') ? path : undefined
}

/** 完成后展示的结果摘要：「做成了什么」。无结果时回落到参数摘要。 */
export function summarizeToolResult(
  toolName: string,
  argsRaw: string | undefined,
  result: string | undefined,
  failed: boolean,
): string | undefined {
  if (result === undefined || result === null) return undefined
  const family = toolFamily(toolName, argsRaw)
  const args = parseArgs(argsRaw)
  const lines = countLines(result)

  if (failed) {
    return oneLine(result, 60) || `失败（${lines} 行输出）`
  }

  switch (family) {
    case 'bash': {
      if (/^\s*$/.test(result)) return '无输出'
      return `${lines} 行输出`
    }
    case 'read': {
      const numbered = result.match(/^\s*\d+\s/m)
      if (numbered !== null) return `${lines} 行`
      return lines > 1 ? `${lines} 行` : oneLine(result, 48)
    }
    case 'write': {
      const content = args.get(['content', 'file_text', 'Content'])
      if (content !== undefined) return `写入 ${countLines(content)} 行`
      return '已写入'
    }
    case 'edit':
      return '已更新'
    case 'search': {
      const matches = countMatchLines(result)
      if (matches !== undefined) return matches === 1 ? '1 个结果' : `${matches} 个结果`
      return lines > 1 ? `${lines} 行` : oneLine(result, 48)
    }
    case 'todo': {
      const items = result.match(/[-*✓x]\s|\[\s*[ x]\]/g)
      return items ? `${items.length} 项` : '已更新'
    }
    case 'agent':
      return oneLine(result, 48) || '完成'
    case 'web': {
      const matches = countMatchLines(result)
      if (matches !== undefined && matches > 0) return matches === 1 ? '1 条结果' : `${matches} 条结果`
      return oneLine(result, 48) || '完成'
    }
    default:
      return oneLine(result, 48) || (lines > 1 ? `${lines} 行输出` : undefined)
  }
}
