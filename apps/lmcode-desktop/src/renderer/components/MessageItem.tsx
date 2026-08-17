import type { Message } from '@/types'
import { memo, useCallback, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, FileText, RotateCcw } from 'lucide-react'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { ToolCallList } from '@/components/ToolCallList'
import { useFileContextMenu, openFileWithSystem } from '@/components/FileActionMenu'
import { resolveOpenTarget, fileUrlToLocalPath } from '@/lib/open-target'
import { AttachmentStrip } from '@/components/AttachmentStrip'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Module-level constants: inline arrays/objects would break React.memo's props
// comparison on every render.
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

/** Recursively extract the plain text out of a rendered code element. */
function extractCodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return extractCodeText(props?.children)
  }
  return ''
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard can be unavailable (e.g. permissions); fall back to the
    // legacy execCommand path rather than failing silently.
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

/** 代码块包裹：右上角复制按钮（模块级组件，避免破坏 memo 的比较）。 */
const CodeBlockWithCopy = memo(function CodeBlockWithCopy({
  children,
}: {
  readonly children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const code = extractCodeText(children).replace(/\n$/, '')

  const handleCopy = useCallback(async () => {
    const ok = await copyText(code)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }, [code])

  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={handleCopy}
        title="复制代码"
        aria-label="复制代码"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--lm-bg-elevated)] text-[var(--lm-text-muted)] opacity-0 shadow-[var(--lm-shadow-soft)] transition-opacity hover:text-[var(--lm-text-primary)] group-hover/code:opacity-100"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
})

const MARKDOWN_COMPONENTS: Components = { pre: CodeBlockWithCopy, a: MarkdownLink, code: MarkdownCode }

/** 行内代码里的输出文件：反引号包裹的本地路径渲染成可点击 chip（左键打开、右键菜单）。 */
const FileChip = memo(function FileChip({ target, children }: { target: string; children?: ReactNode }) {
  const fileMenu = useFileContextMenu()
  return (
    <>
      {fileMenu.menu}
      <button
        type="button"
        title={`打开 ${target}`}
        aria-label={`打开文件 ${target}`}
        onClick={() => void openFileWithSystem(target)}
        onContextMenu={fileMenu.openFromEvent(target)}
        className="inline-flex max-w-full items-baseline gap-1 rounded-md border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-1.5 py-0.5 transition-colors hover:border-[var(--lm-border-strong)] hover:bg-[var(--lm-bg-hover)]"
      >
        <FileText size={11} className="shrink-0 translate-y-px text-[var(--lm-text-muted)]" />
        <span className="truncate">{children}</span>
      </button>
    </>
  )
})

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const text = extractCodeText(children)
  if (className !== undefined || text.endsWith('\n')) return <code className={className}>{children}</code>
  const target = resolveOpenTarget(text)
  if (target !== null) return <FileChip target={target}>{children}</FileChip>
  return <code>{children}</code>
}

/** 对话里的链接：file:// 交给系统默认程序，https 交给系统浏览器，其余保持默认。 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const handle = href === undefined ? undefined : (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (href.startsWith('file://')) {
      event.preventDefault()
      const path = fileUrlToLocalPath(href)
      if (path !== null) void window.lmcodeAPI.openPath(path)
      return
    }
    if (href.startsWith('https://')) {
      event.preventDefault()
      void window.lmcodeAPI.openExternal(href)
    }
  }
  return (
    <a href={href} onClick={handle} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

interface MessageItemProps {
  message: Message
  /** 该消息正在流式增长（仅最后一条 assistant 消息为 true）。流式期间用纯文本渲染，结束后再解析 Markdown。 */
  isStreaming?: boolean
  /** 仅最后一条 assistant 消息提供：点击撤销上一轮并重发其前一条用户消息。 */
  onRegenerate?: () => void
}

// memoized: during streaming only the last assistant message gets a new object
// identity (see patchLastAssistant), so historical items bail out of the
// expensive markdown + highlight.js re-render.
export const MessageItem = memo(function MessageItem({
  message,
  isStreaming = false,
  onRegenerate,
}: MessageItemProps) {
  const { role } = message
  const [copied, setCopied] = useState(false)

  const handleCopyMessage = useCallback(async () => {
    const ok = await copyText(message.content ?? '')
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }, [message.content])

  // ── User: right-aligned warm bubble ────────────────────────────────
  if (role === 'user') {
    return (
      <div className="group flex animate-fade-in justify-end">
        <div className="relative flex max-w-[82%] flex-col gap-2 rounded-[18px] bg-[var(--lm-bg-bubble)] px-3 py-2.5 text-[14px] leading-relaxed text-[var(--lm-text-primary)]">
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentStrip attachments={message.attachments} />
          )}
          {message.content && <span className="whitespace-pre-wrap px-1">{message.content}</span>}
          {message.content && (
            <button
              type="button"
              onClick={handleCopyMessage}
              title="复制消息"
              aria-label="复制消息"
              className="absolute -right-9 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-[var(--lm-text-muted)] opacity-0 transition-opacity hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] group-hover:opacity-100"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── System / tool notices ──────────────────────────────────────────
  if (role === 'system' || role === 'tool') {
    const isError = message.variant === 'error'
    return (
      <div className="flex animate-fade-in justify-center">
        <div
          className={
            isError
              ? 'flex items-center gap-2 rounded-lg border border-[var(--lm-error)]/40 bg-[var(--lm-error)]/10 px-3 py-2 text-[12px] text-[var(--lm-error)]'
              : 'rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[12px] text-[var(--lm-text-muted)]'
          }
        >
          {isError && <AlertTriangle size={13} className="shrink-0" />}
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      </div>
    )
  }

  // ── Assistant: avatar + flowing prose ──────────────────────────────
  const showActions = !isStreaming && (onRegenerate !== undefined || message.content)

  return (
    <div className="group flex animate-fade-in gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--lm-accent-soft)] text-[12px] font-bold text-[var(--lm-accent-text)]">
        L
      </div>

      <div className="min-w-0 flex-1">
        {message.thinking && (
          <ThinkingBlock content={message.thinking} state={message.thinkingState} />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2 space-y-0.5">
            <ToolCallList toolCalls={message.toolCalls} />
          </div>
        )}

        <div className="relative">
          {message.content ? (
            isStreaming ? (
              // Streaming: render plain text + cursor instead of re-parsing the
              // whole growing markdown on every delta (O(n²) otherwise). The
              // final markdown render happens once when the turn ends.
              <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--lm-text-primary)]">
                {message.content}
                <span className="lm-cursor-blink ml-0.5 inline-block text-[var(--lm-accent-text)]">▍</span>
              </div>
            ) : (
              <div className="lm-markdown">
                <Markdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {message.content}
                </Markdown>
              </div>
            )
          ) : message.thinkingState === 'streaming' ? (
            <span className="lm-pulse text-[13px] text-[var(--lm-text-muted)]">思考中…</span>
          ) : null}

          {showActions && (
            <div className="absolute -top-2 right-0 flex items-center gap-0.5 rounded-md bg-[var(--lm-bg-elevated)] px-1 py-0.5 opacity-0 shadow-[var(--lm-shadow-soft)] transition-opacity group-hover:opacity-100">
              {onRegenerate !== undefined && (
                <button
                  type="button"
                  onClick={onRegenerate}
                  title="重新生成"
                  aria-label="重新生成"
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                >
                  <RotateCcw size={12} />
                  重新生成
                </button>
              )}
              {message.content && (
                <button
                  type="button"
                  onClick={handleCopyMessage}
                  title="复制消息"
                  aria-label="复制消息"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
