import type { Message } from '@/types'
import type { ReactNode } from 'react'
import { AlertTriangle, FileText } from 'lucide-react'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { ToolCallList } from '@/components/ToolCallList'
import { useFileContextMenu, openFileWithSystem } from '@/components/FileActionMenu'
import { resolveOpenTarget, fileUrlToLocalPath } from '@/lib/open-target'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

function extractCodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return extractCodeText(props?.children)
  }
  return ''
}

function FileChip({ target, children }: { readonly target: string; readonly children?: ReactNode }) {
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
}

function MarkdownCode({ className, children }: { readonly className?: string; readonly children?: ReactNode }) {
  const text = extractCodeText(children)
  if (className !== undefined || text.endsWith('\n')) return <code className={className}>{children}</code>
  const target = resolveOpenTarget(text)
  if (target !== null) return <FileChip target={target}>{children}</FileChip>
  return <code>{children}</code>
}

function MarkdownLink({ href, children }: { readonly href?: string; readonly children?: ReactNode }) {
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

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink, code: MarkdownCode }

interface MessageItemProps {
  message: Message
}

export function MessageItem({ message }: MessageItemProps) {
  const { role } = message

  // ── User: right-aligned warm bubble ────────────────────────────────
  if (role === 'user') {
    return (
      <div className="flex animate-fade-in justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-[18px] bg-[var(--lm-bg-bubble)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--lm-text-primary)]">
          {message.content}
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
  return (
    <div className="flex animate-fade-in gap-3">
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

        {message.content ? (
          <div className="lm-markdown">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MARKDOWN_COMPONENTS}>
              {message.content}
            </Markdown>
          </div>
        ) : message.thinkingState === 'streaming' ? (
          <span className="lm-pulse text-[13px] text-[var(--lm-text-muted)]">思考中…</span>
        ) : null}
      </div>
    </div>
  )
}
