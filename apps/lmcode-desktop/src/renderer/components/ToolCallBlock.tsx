import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ToolCallInfo } from '@/types'
import { toolFamily, summarizeToolArgs, summarizeToolResult, toolFilePath } from '@/lib/tool-summary'
import { useFileContextMenu, openFileWithSystem } from '@/components/FileActionMenu'
import {
  Loader2,
  CheckCircle2,
  XCircle,
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
  Globe,
} from 'lucide-react'

interface ToolCallBlockProps {
  toolCall: ToolCallInfo
}

const FAMILY_ICONS = {
  bash: Terminal,
  read: FileText,
  write: FileCode,
  edit: FileEdit,
  search: Search,
  todo: ListTodo,
  agent: Bot,
  web: Globe,
  other: Sparkles,
} as const

const FAMILY_TITLES = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  search: 'Search',
  todo: 'TodoList',
  agent: 'Agent',
  web: 'Web',
} as const

interface ToolMeta {
  variant: keyof typeof FAMILY_ICONS
  title: string
  icon: typeof Terminal
}

function classifyTool(toolName: string, argsRaw?: string): ToolMeta {
  const family = toolFamily(toolName, argsRaw)
  const title = family === 'other' ? toolName || 'Tool' : FAMILY_TITLES[family]
  return { variant: family, icon: FAMILY_ICONS[family], title }
}

export function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileMenu = useFileContextMenu()
  const filePath = useMemo(
    () => toolFilePath(toolCall.toolName, toolCall.args),
    [toolCall.toolName, toolCall.args],
  )

  const meta = useMemo(() => classifyTool(toolCall.toolName, toolCall.args), [toolCall.toolName, toolCall.args])
  const ToolIcon = meta.icon

  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending'
  const isFailed = toolCall.status === 'failed'
  const isCompleted = toolCall.status === 'completed'

  // 运行中展示「要做什么」（参数摘要），结束后展示「做成了什么」（结果摘要）。
  const summary = useMemo(() => {
    if (isCompleted || isFailed) {
      return summarizeToolResult(toolCall.toolName, toolCall.args, toolCall.result, isFailed)
        ?? summarizeToolArgs(toolCall.toolName, toolCall.args)
    }
    return summarizeToolArgs(toolCall.toolName, toolCall.args)
  }, [toolCall.toolName, toolCall.args, toolCall.result, isCompleted, isFailed])

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(toolCall.result || toolCall.args || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // 折叠态：无边框单行（ZCode 风格「工具 · 摘要」）；展开态才呈现卡片细节。
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg text-[12.5px] transition-all duration-150',
        expanded
          ? 'border border-[var(--lm-border)] bg-[var(--lm-bg-surface)]'
          : 'border border-transparent hover:border-[var(--lm-border)] hover:bg-[var(--lm-bg-surface)]/60',
      )}
      onContextMenu={filePath === undefined ? undefined : fileMenu.openFromEvent(filePath)}
    >
      {fileMenu.menu}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2 py-[5px] text-left transition-colors hover:bg-[var(--lm-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-[var(--lm-text-muted)] shrink-0 transition-transform" />
        ) : (
          <ChevronRight size={13} className="text-[var(--lm-text-muted)] shrink-0 transition-transform" />
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ToolIcon size={13} className="text-[var(--lm-text-muted)] shrink-0" />
          <span className="shrink-0 font-medium text-[var(--lm-text-secondary)]">{meta.title}</span>
          {summary && (
            <>
              <span className="shrink-0 text-[var(--lm-text-muted)]/60">·</span>
              {filePath !== undefined ? (
                <span
                  role="button"
                  tabIndex={0}
                  title={`点击用系统默认程序打开：${filePath}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void openFileWithSystem(filePath)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.stopPropagation()
                      void openFileWithSystem(filePath)
                    }
                  }}
                  className="cursor-pointer truncate font-mono text-[11.5px] text-[var(--lm-text-muted)] underline decoration-dotted decoration-[var(--lm-text-muted)]/40 underline-offset-2 hover:text-[var(--lm-accent-text)] hover:decoration-[var(--lm-accent-text)]"
                >
                  {summary}
                </span>
              ) : (
                <span className="truncate font-mono text-[11.5px] text-[var(--lm-text-muted)]">{summary}</span>
              )}
            </>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isRunning && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--lm-accent-text)]">
              <Loader2 size={12} className="lm-spin" />
              <span>运行中</span>
            </span>
          )}
          {isPending && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--lm-text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--lm-text-muted)]/50" />
              <span>等待</span>
            </span>
          )}
          {isCompleted && (
            <span className="flex items-center text-[var(--lm-success)]">
              <CheckCircle2 size={13} />
            </span>
          )}
          {isFailed && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--lm-error)]">
              <XCircle size={13} />
              <span>失败</span>
            </span>
          )}
        </div>
      </button>

      {/* Expanded Details Pane */}
      {expanded && (
        <div className="divide-y divide-[var(--lm-border)] border-t border-[var(--lm-border)] bg-[var(--lm-bg-base)]/50">
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
                </span>
                <div className="flex items-center gap-2">
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
                {toolCall.result}
              </pre>
            </div>
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
