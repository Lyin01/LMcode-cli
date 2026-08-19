import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { FileText, MessageSquarePlus, Send, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activateModalPanel } from '@/lib/modal-panel-controller'
import { blockExcerpt, splitMarkdownBlocks } from '@/lib/markdown-blocks'
import { formatArtifactComments } from '@/lib/artifact-comments'
import { formatSessionActivity } from '@/lib/session-list'
import {
  activeCommentCount,
  useArtifactsStore,
  type Artifact,
  type ArtifactComment,
} from '@/stores/artifacts-store'

// Module-level constants: inline arrays would break downstream memoization
// and re-instantiate the markdown pipeline on every render.
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

const KIND_LABEL: Record<Artifact['kind'], string> = {
  plan: '计划',
  report: '文档',
}

interface ArtifactPanelProps {
  /** 反馈文本注入会话 composer（与 Git 审查共用同一注入机制）。 */
  readonly onSendFeedback: (text: string) => void
}

function commentsForBlock(
  comments: readonly ArtifactComment[],
  blockIndex: number,
): ArtifactComment[] {
  return comments.filter((comment) => comment.anchor.blockIndex === blockIndex)
}

function CommentEntry({
  artifactId,
  comment,
}: {
  readonly artifactId: string
  readonly comment: ArtifactComment
}) {
  const removeComment = useArtifactsStore((state) => state.removeComment)
  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-2.5 py-2',
        comment.outdated && 'opacity-55',
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--lm-text-muted)]">
          第 {comment.anchor.blockIndex + 1} 段「{comment.anchor.excerpt}」
        </span>
        <button
          type="button"
          aria-label="删除评论"
          title="删除评论"
          onClick={() => removeComment(artifactId, comment.id)}
          className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] text-[var(--lm-text-primary)]">
        {comment.text}
      </p>
      {comment.outdated && (
        <span className="mt-1 inline-block rounded bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)]">
          已过期
        </span>
      )}
    </div>
  )
}

export function ArtifactPanel({ onSendFeedback }: ArtifactPanelProps) {
  const artifact = useArtifactsStore((state) =>
    state.panelArtifactId === null
      ? undefined
      : state.artifacts.find((entry) => entry.id === state.panelArtifactId),
  )
  const closePanel = useArtifactsStore((state) => state.closePanel)
  const addComment = useArtifactsStore((state) => state.addComment)
  const panelRef = useRef<HTMLDivElement>(null)
  // Stable close callback for the modal controller (same reasoning as InboxPanel).
  const closeRef = useRef(closePanel)
  closeRef.current = closePanel

  const [commentingBlock, setCommentingBlock] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  const open = artifact !== undefined
  const artifactId = artifact?.id ?? null

  // 切换文档时收起未提交的评论输入。
  useEffect(() => {
    setCommentingBlock(null)
    setDraft('')
  }, [artifactId])

  // Modal lifecycle: initial focus, Escape closes, Tab rings inside the
  // panel, and closing restores focus to the element that opened the drawer.
  useEffect(() => {
    if (!open || !panelRef.current) return
    return activateModalPanel(panelRef.current, { onClose: () => closeRef.current() })
  }, [open])

  // 与 store 重锚逻辑共用同一份切分，保证渲染块序号 == 评论锚点 blockIndex。
  const blocks = useMemo(
    () => (artifact ? splitMarkdownBlocks(artifact.content) : []),
    [artifact],
  )

  if (!open || !artifact) return null

  const submitComment = (): void => {
    const text = draft.trim()
    if (commentingBlock === null || text.length === 0) return
    const block = blocks[commentingBlock]
    if (block === undefined) return
    addComment(artifact.id, { blockIndex: commentingBlock, excerpt: blockExcerpt(block) }, text)
    setCommentingBlock(null)
    setDraft('')
  }

  const sendFeedback = (): void => {
    if (activeCommentCount(artifact) === 0) return
    onSendFeedback(formatArtifactComments(artifact, artifact.comments))
    closePanel()
  }

  return (
    <div className="fixed inset-x-0 top-0 bottom-[var(--lm-global-usage-height)] z-40 flex">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={closePanel}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-artifact-panel-title"
        className="relative z-10 ml-auto flex h-full w-[760px] max-w-[92vw] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={16} className="shrink-0 text-[var(--lm-accent-text)]" />
            <h2
              id="lm-artifact-panel-title"
              className="truncate text-[15px] font-semibold text-[var(--lm-text-primary)]"
            >
              {artifact.title}
            </h2>
            <span className="shrink-0 rounded-full bg-[var(--lm-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--lm-accent-text)]">
              {KIND_LABEL[artifact.kind]}
            </span>
            <span className="shrink-0 text-[10.5px] text-[var(--lm-text-muted)]">
              v{artifact.version} · 更新于 {formatSessionActivity(artifact.updatedAt)}
            </span>
          </div>
          <button
            type="button"
            aria-label="关闭文档审阅"
            title="关闭文档审阅"
            data-lm-autofocus="true"
            onClick={closePanel}
            className="shrink-0 rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: 文档 + 评论侧栏 */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {blocks.map((block, index) => {
              const blockComments = commentsForBlock(artifact.comments, index)
              return (
                <div
                  key={index}
                  data-lm-artifact-block={index}
                  className="group relative rounded-md px-2 py-1 transition-colors hover:bg-[var(--lm-bg-hover)]/50"
                >
                  <div className="lm-markdown">
                    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                      {block}
                    </Markdown>
                  </div>
                  <button
                    type="button"
                    aria-label={`评论第 ${index + 1} 段`}
                    title={`评论第 ${index + 1} 段`}
                    onClick={() => {
                      setCommentingBlock(index)
                      setDraft('')
                    }}
                    className="absolute right-1 top-1 rounded-md p-1 text-[var(--lm-text-muted)] opacity-0 transition-all hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-accent-text)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <MessageSquarePlus size={14} />
                  </button>
                  {blockComments.length > 0 && (
                    <span className="absolute -left-0.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--lm-accent-soft)] px-1 text-[9.5px] font-medium text-[var(--lm-accent-text)]">
                      {blockComments.length}
                    </span>
                  )}

                  {commentingBlock === index && (
                    <div className="mt-1.5 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-2">
                      <textarea
                        aria-label={`第 ${index + 1} 段评论`}
                        placeholder="写下对这一段的意见…"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={3}
                        className="w-full resize-y rounded-md border border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-2 py-1.5 text-[12px] text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)] focus:border-[var(--lm-accent-text)]"
                      />
                      <div className="mt-1.5 flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCommentingBlock(null)
                            setDraft('')
                          }}
                          className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)]"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={draft.trim().length === 0}
                          onClick={submitComment}
                          className="rounded-md bg-[var(--lm-accent-soft)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--lm-accent-text)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          提交评论
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* 评论侧栏 */}
          <div className="flex w-[240px] shrink-0 flex-col border-l border-[var(--lm-border)]">
            <div className="border-b border-[var(--lm-border)] px-3 py-2.5 text-[11.5px] font-medium text-[var(--lm-text-secondary)]">
              评论（{artifact.comments.length}）
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
              {artifact.comments.length === 0 && (
                <p className="px-1 py-6 text-center text-[11.5px] text-[var(--lm-text-muted)]">
                  点击文档段落右侧的评论按钮，按段落留下意见
                </p>
              )}
              {artifact.comments.map((comment) => (
                <CommentEntry key={comment.id} artifactId={artifact.id} comment={comment} />
              ))}
            </div>
            <div className="border-t border-[var(--lm-border)] p-3">
              <button
                type="button"
                aria-label="发送反馈"
                title="发送反馈"
                disabled={activeCommentCount(artifact) === 0}
                onClick={sendFeedback}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--lm-accent-soft)] px-3 py-2 text-[12px] font-medium text-[var(--lm-accent-text)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={13} />
                发送反馈（{activeCommentCount(artifact)}）
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
