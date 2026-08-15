import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ToolCallInfo } from '@/types'
import { artifactIdForToolCall, useArtifactsStore } from '@/stores/artifacts-store'
import { pruneToolOutput, formatCharCount } from '@/lib/tool-pruner'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  FileCode,
  FileEdit,
  Search,
  ListTodo,
  Bot,
  Sparkles,
  Copy,
  Check,
  Code2,
  Maximize2,
  Minimize2,
} from 'lucide-react'

interface ToolCallBlockProps {
  toolCall: ToolCallInfo
}

interface ToolMeta {
  variant: 'terminal' | 'read' | 'write' | 'edit' | 'search' | 'todo' | 'subagent' | 'other'
  title: string
  icon: typeof Terminal
  summary?: string
}

function classifyTool(toolName: string, argsRaw?: string): ToolMeta {
  const name = (toolName || '').toLowerCase()
  let parsedArgs: Record<string, unknown> | null = null
  if (argsRaw) {
    try {
      parsedArgs = JSON.parse(argsRaw)
    } catch {
      // Ignore JSON parse error
    }
  }

  const getArg = (keys: string[]): string | undefined => {
    if (!parsedArgs) return undefined
    for (const k of keys) {
      const v = parsedArgs[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }

  // 1. Terminal / Shell
  if (name.includes('command') || name.includes('bash') || name.includes('pwsh') || name.includes('terminal') || name.includes('exec')) {
    const cmd = getArg(['CommandLine', 'command', 'cmd', 'script'])
    const shortCmd = cmd ? cmd.split('\n')[0]?.slice(0, 50) : undefined
    return {
      variant: 'terminal',
      title: 'Bash',
      icon: Terminal,
      summary: shortCmd,
    }
  }

  // 2. Read File / URL
  if (name.includes('view_file') || name.includes('read_file') || name.includes('read_url') || name.startsWith('read')) {
    const path = getArg(['AbsolutePath', 'TargetFile', 'path', 'filePath', 'Url', 'url'])
    const shortPath = path ? path.replace(/^[a-zA-Z]:[/\\]/, '').split(/[/\\]/).slice(-2).join('/') : undefined
    return {
      variant: 'read',
      title: 'Read',
      icon: FileText,
      summary: shortPath || path,
    }
  }

  // 3. Write / Create File
  if (name.includes('write_to_file') || name.includes('write_file') || name.startsWith('write') || name.includes('create_file')) {
    const path = getArg(['TargetFile', 'AbsolutePath', 'path', 'filePath'])
    const shortPath = path ? path.replace(/^[a-zA-Z]:[/\\]/, '').split(/[/\\]/).slice(-2).join('/') : undefined
    return {
      variant: 'write',
      title: 'Write',
      icon: FileCode,
      summary: shortPath || path,
    }
  }

  // 4. Edit / Replace File
  if (name.includes('replace_file') || name.includes('multi_replace') || name.includes('edit_file') || name.startsWith('edit')) {
    const path = getArg(['TargetFile', 'AbsolutePath', 'path', 'filePath'])
    const shortPath = path ? path.replace(/^[a-zA-Z]:[/\\]/, '').split(/[/\\]/).slice(-2).join('/') : undefined
    return {
      variant: 'edit',
      title: 'Edit',
      icon: FileEdit,
      summary: shortPath || path,
    }
  }

  // 5. Search / Grep / Glob
  if (name.includes('search') || name.includes('grep') || name.includes('list_dir') || name.includes('glob') || name.includes('find')) {
    const query = getArg(['Query', 'query', 'pattern', 'DirectoryPath', 'path'])
    return {
      variant: 'search',
      title: 'Search',
      icon: Search,
      summary: query ? `"${query.slice(0, 40)}"` : undefined,
    }
  }

  // 6. Todo / Task List
  if (name.includes('todo') || name.includes('task')) {
    const title = getArg(['Prompt', 'title', 'task', 'description'])
    return {
      variant: 'todo',
      title: 'TodoList',
      icon: ListTodo,
      summary: title ? title.slice(0, 40) : undefined,
    }
  }

  // 7. Subagents
  if (name.includes('subagent') || name.includes('agent')) {
    const role = getArg(['Role', 'role', 'name', 'Prompt'])
    return {
      variant: 'subagent',
      title: 'Subagent',
      icon: Bot,
      summary: role ? role.slice(0, 40) : undefined,
    }
  }

  // Default fallback
  const firstVal = parsedArgs ? Object.values(parsedArgs).find((v) => typeof v === 'string' && v.trim()) as string : undefined
  return {
    variant: 'other',
    title: toolName || 'Tool',
    icon: Sparkles,
    summary: firstVal ? firstVal.slice(0, 40) : undefined,
  }
}

export function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [showFullOutput, setShowFullOutput] = useState(false)
  const [copied, setCopied] = useState(false)

  const meta = useMemo(() => classifyTool(toolCall.toolName, toolCall.args), [toolCall.toolName, toolCall.args])
  const ToolIcon = meta.icon

  const artifactId = useArtifactsStore((state) =>
    artifactIdForToolCall(state.artifacts, toolCall.id),
  )

  const duration =
    toolCall.startedAt !== undefined && toolCall.endedAt !== undefined
      ? toolCall.endedAt - toolCall.startedAt
      : null
  const durationLabel =
    duration !== null ? (duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`) : null

  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'
  const isCompleted = toolCall.status === 'completed'

  const prunedResult = useMemo(() => {
    if (!toolCall.result) return null
    return pruneToolOutput(toolCall.result)
  }, [toolCall.result])

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(toolCall.result || toolCall.args || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[12.5px] transition-all duration-150 hover:border-[var(--lm-border-strong)]">
      {/* DSH-style Header Row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-[var(--lm-text-muted)] shrink-0 transition-transform" />
        ) : (
          <ChevronRight size={14} className="text-[var(--lm-text-muted)] shrink-0 transition-transform" />
        )}

        <div className="flex items-center gap-2 min-w-0">
          <ToolIcon size={14} className="text-[var(--lm-text-secondary)] shrink-0" />
          <span className="font-semibold text-[var(--lm-text-primary)] shrink-0">{meta.title}</span>
          {meta.summary && (
            <span className="truncate font-mono text-[11.5px] text-[var(--lm-text-muted)]">
              {meta.summary}
            </span>
          )}
        </div>

        {/* Right Status Badge (DSH Style) */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {isRunning && (
            <span className="flex items-center gap-1.5 font-medium text-[11.5px] text-[var(--lm-accent-text)]">
              <Loader2 size={13} className="lm-spin text-[var(--lm-accent-text)]" />
              <span>运行中</span>
            </span>
          )}

          {isCompleted && (
            <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--lm-success)]">
              <CheckCircle2 size={13} />
              <span>已完成</span>
            </span>
          )}

          {isFailed && (
            <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--lm-error)]">
              <XCircle size={13} />
              <span>失败</span>
            </span>
          )}

          {durationLabel && (
            <span className="font-mono text-[10.5px] text-[var(--lm-text-muted)]">
              {durationLabel}
            </span>
          )}
        </div>
      </button>

      {/* Expanded Details Pane */}
      {expanded && (
        <div className="border-t border-[var(--lm-border)] bg-[var(--lm-bg-base)]/50 divide-y divide-[var(--lm-border)]">
          {/* Tool Parameters */}
          {toolCall.args && (
            <div className="p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-[var(--lm-text-muted)]">
                <span className="flex items-center gap-1">
                  <Code2 size={12} />
                  调用参数
                </span>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--lm-bg-code)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--lm-text-secondary)] border border-[var(--lm-border)]">
                {toolCall.args}
              </pre>
            </div>
          )}

          {/* Tool Output Result */}
          {toolCall.result && (
            <div className="p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-[var(--lm-text-muted)]">
                <span className="flex items-center gap-1">
                  <Terminal size={12} />
                  输出结果
                  {prunedResult?.isPruned && (
                    <span className="ml-1 text-[10px] text-[var(--lm-accent-text)]">
                      (已自动精简 {formatCharCount(prunedResult.prunedChars)})
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {prunedResult?.isPruned && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setShowFullOutput(!showFullOutput)
                      }}
                      className="flex items-center gap-1 text-[11px] text-[var(--lm-accent-text)] hover:underline"
                    >
                      {showFullOutput ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
                      <span>{showFullOutput ? '精简视图' : '查看全量'}</span>
                    </button>
                  )}
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                    title="复制完整输出"
                  >
                    {copied ? <Check size={11} className="text-[var(--lm-success)]" /> : <Copy size={11} />}
                    <span>{copied ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>

              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--lm-bg-code)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--lm-text-secondary)] border border-[var(--lm-border)]">
                {showFullOutput || !prunedResult?.isPruned ? toolCall.result : prunedResult.displayContent}
              </pre>
            </div>
          )}

          {/* Artifact Link */}
          {artifactId !== null && (
            <button
              type="button"
              aria-label="打开文档审阅"
              title="打开文档审阅"
              onClick={() => useArtifactsStore.getState().openPanel(artifactId)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] font-medium text-[var(--lm-accent-text)] transition-colors hover:bg-[var(--lm-bg-hover)]"
            >
              <FileText size={13} />
              打开生成的文档/报告审阅
            </button>
          )}

          {/* Progress Stream */}
          {toolCall.progress && isRunning && (
            <div className="px-3 py-1.5 text-[11px] text-[var(--lm-text-muted)]">
              {toolCall.progress}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
