import { useMemo, useState } from 'react'
import { MessageSquarePlus, Minus, Plus, Trash2, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseGitDiff, type ParsedDiffLine } from '@/lib/git-diff'
import type {
  GitDiffSection,
  GitHunkActionInput,
  GitHunkSectionKind,
} from '../../shared/git-types'

export type GitReviewCommentSide = 'old' | 'new'

export interface GitReviewComment {
  readonly id: string
  readonly filePath: string
  readonly sectionKind: GitDiffSection['kind']
  readonly line: number
  readonly side: GitReviewCommentSide
  readonly body: string
}

export interface GitReviewCommentInput {
  readonly filePath: string
  readonly sectionKind: GitDiffSection['kind']
  readonly line: number
  readonly side: GitReviewCommentSide
  readonly body: string
}

interface GitDiffViewProps {
  readonly filePath: string
  readonly section: GitDiffSection
  readonly comments: readonly GitReviewComment[]
  readonly disabled: boolean
  readonly onSaveComment: (comment: GitReviewCommentInput) => void
  readonly onDeleteComment: (commentId: string) => void
  readonly onHunkAction: (input: GitHunkActionInput) => void
}

interface CommentTarget {
  readonly lineId: string
  readonly line: number
  readonly side: GitReviewCommentSide
}

const SECTION_LABELS: Record<GitDiffSection['kind'], string> = {
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪文件',
}

function lineClass(kind: ParsedDiffLine['kind']): string {
  switch (kind) {
    case 'addition':
      return 'text-[var(--lm-success)]'
    case 'deletion':
      return 'text-[var(--lm-error)]'
    case 'annotation':
    case 'metadata':
      return 'text-[var(--lm-text-muted)]'
    case 'context':
      return 'text-[var(--lm-text-secondary)]'
  }
}

function lineStyle(kind: ParsedDiffLine['kind']): React.CSSProperties | undefined {
  if (kind === 'addition') {
    return { backgroundColor: 'color-mix(in srgb, var(--lm-success) 9%, transparent)' }
  }
  if (kind === 'deletion') {
    return { backgroundColor: 'color-mix(in srgb, var(--lm-error) 9%, transparent)' }
  }
  return undefined
}

function commentTargetForLine(line: ParsedDiffLine): CommentTarget | null {
  if (line.newLine !== null) {
    return { lineId: line.id, line: line.newLine, side: 'new' }
  }
  if (line.oldLine !== null) {
    return { lineId: line.id, line: line.oldLine, side: 'old' }
  }
  return null
}

function sameCommentTarget(
  comment: GitReviewComment,
  filePath: string,
  sectionKind: GitDiffSection['kind'],
  target: CommentTarget,
): boolean {
  return comment.filePath === filePath &&
    comment.sectionKind === sectionKind &&
    comment.line === target.line &&
    comment.side === target.side
}

export function GitDiffView({
  filePath,
  section,
  comments,
  disabled,
  onSaveComment,
  onDeleteComment,
  onHunkAction,
}: GitDiffViewProps) {
  const parsed = useMemo(() => parseGitDiff(section.patch), [section.patch])
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null)
  const [commentDraft, setCommentDraft] = useState('')

  const openComment = (target: CommentTarget): void => {
    const existing = comments.find((comment) =>
      sameCommentTarget(comment, filePath, section.kind, target))
    setCommentTarget(target)
    setCommentDraft(existing?.body ?? '')
  }

  const saveComment = (): void => {
    const body = commentDraft.trim()
    if (!commentTarget || !body) return
    onSaveComment({
      filePath,
      sectionKind: section.kind,
      line: commentTarget.line,
      side: commentTarget.side,
      body,
    })
    setCommentTarget(null)
    setCommentDraft('')
  }

  const actionInput = (
    hunkIndex: number,
    action: GitHunkActionInput['action'],
  ): GitHunkActionInput | null => {
    if (section.kind === 'untracked') return null
    return {
      filePath,
      sectionKind: section.kind satisfies GitHunkSectionKind,
      hunkIndex,
      action,
    }
  }

  return (
    <section className="border-b border-[var(--lm-border)] last:border-b-0">
      <div className="sticky top-0 z-20 flex min-h-8 items-center gap-2 border-y border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-3 py-1.5 text-[11px] font-medium text-[var(--lm-text-secondary)]">
        {SECTION_LABELS[section.kind]}
        <span className="font-normal text-[var(--lm-text-muted)]">
          {parsed.hunks.length} 个代码块
        </span>
        {section.truncated && (
          <span className="rounded-full bg-[var(--lm-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--lm-accent-text)]">
            预览已截断
          </span>
        )}
      </div>

      {parsed.metadata.length > 0 && (
        <div className="border-b border-[var(--lm-border)] bg-[var(--lm-bg-code)] py-1 font-mono text-[10px] leading-4 text-[var(--lm-text-muted)]">
          {parsed.metadata.map((line) => (
            <div key={line.id} className="px-3">{line.content || ' '}</div>
          ))}
        </div>
      )}

      {parsed.hunks.map((hunk) => (
        <div key={hunk.index} className="border-b border-[var(--lm-border)] last:border-b-0">
          <div className="sticky top-8 z-10 flex min-h-8 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)] px-2 py-1 font-mono text-[10px] text-[var(--lm-accent-text)]">
            <span className="min-w-0 flex-1 truncate" title={hunk.header}>
              {hunk.header}
            </span>
            {section.kind === 'unstaged' && (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    const input = actionInput(hunk.index, 'stage')
                    if (input) onHunkAction(input)
                  }}
                  className="flex items-center gap-1 rounded border border-[var(--lm-border-strong)] px-1.5 py-0.5 font-sans text-[9px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-40"
                  title="只暂存这个代码块"
                >
                  <Plus size={9} /> 暂存此块
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    const input = actionInput(hunk.index, 'revert')
                    if (input) onHunkAction(input)
                  }}
                  className="flex items-center gap-1 rounded border border-[var(--lm-border-strong)] px-1.5 py-0.5 font-sans text-[9px] text-[var(--lm-error)] hover:bg-[var(--lm-accent-soft)] disabled:opacity-40"
                  title="永久撤销这个代码块"
                >
                  <Undo2 size={9} /> 撤销此块
                </button>
              </>
            )}
            {section.kind === 'staged' && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const input = actionInput(hunk.index, 'unstage')
                  if (input) onHunkAction(input)
                }}
                className="flex items-center gap-1 rounded border border-[var(--lm-border-strong)] px-1.5 py-0.5 font-sans text-[9px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-40"
                title="只取消暂存这个代码块"
              >
                <Minus size={9} /> 取消暂存此块
              </button>
            )}
          </div>

          <div className="min-w-max bg-[var(--lm-bg-code)] py-1 font-mono text-[11px] leading-5">
            {hunk.lines.map((line) => {
              const target = commentTargetForLine(line)
              const lineComments = target
                ? comments.filter((comment) =>
                    sameCommentTarget(comment, filePath, section.kind, target))
                : []
              const editorOpen = target !== null && commentTarget?.lineId === target.lineId
              return (
                <div key={line.id}>
                  <div
                    className={cn('group flex min-h-5 items-stretch', lineClass(line.kind))}
                    style={lineStyle(line.kind)}
                  >
                    <span className="sticky left-0 flex w-6 shrink-0 items-center justify-center border-r border-[var(--lm-border)] bg-[var(--lm-bg-code)]">
                      {target && (
                        <button
                          type="button"
                          onClick={() => openComment(target)}
                          className="rounded p-0.5 text-[var(--lm-accent-text)] opacity-0 hover:bg-[var(--lm-accent-soft)] focus:opacity-100 group-hover:opacity-100"
                          aria-label={`在 ${filePath} 第 ${target.line} 行添加评论`}
                          title="添加行内评论"
                        >
                          <MessageSquarePlus size={11} />
                        </button>
                      )}
                    </span>
                    <span className="w-9 shrink-0 select-none border-r border-[var(--lm-border)] px-1 text-right text-[9px] text-[var(--lm-text-muted)]">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="w-9 shrink-0 select-none border-r border-[var(--lm-border)] px-1 text-right text-[9px] text-[var(--lm-text-muted)]">
                      {line.newLine ?? ''}
                    </span>
                    <span className="w-5 shrink-0 select-none text-center">{line.marker}</span>
                    <code className="block min-w-0 flex-1 whitespace-pre pr-3">{line.content || ' '}</code>
                  </div>

                  {lineComments.map((comment) => (
                    <div
                      key={comment.id}
                      className="ml-[6.5rem] mr-3 my-1.5 flex max-w-2xl items-start gap-2 rounded-md border border-[var(--lm-accent)] bg-[var(--lm-bg-elevated)] px-2.5 py-2 font-sans text-[11px] leading-4 text-[var(--lm-text-primary)]"
                    >
                      <span className="min-w-0 flex-1 whitespace-pre-wrap">{comment.body}</span>
                      <button
                        type="button"
                        onClick={() => onDeleteComment(comment.id)}
                        className="shrink-0 rounded p-0.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)]"
                        aria-label={`删除 ${filePath} 第 ${comment.line} 行的评论`}
                        title="删除评论"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}

                  {editorOpen && target && (
                    <div className="ml-[6.5rem] mr-3 my-1.5 max-w-2xl rounded-lg border border-[var(--lm-accent)] bg-[var(--lm-bg-elevated)] p-2 shadow-[var(--lm-shadow-soft)]">
                      <div className="mb-1.5 flex items-center gap-2 font-sans text-[10px] text-[var(--lm-text-muted)]">
                        评论 {filePath}:{target.line}
                        <button
                          type="button"
                          onClick={() => setCommentTarget(null)}
                          className="ml-auto rounded p-0.5 hover:bg-[var(--lm-bg-hover)]"
                          aria-label="关闭评论编辑器"
                        >
                          <X size={11} />
                        </button>
                      </div>
                      <textarea
                        value={commentDraft}
                        onChange={(event) => setCommentDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault()
                            saveComment()
                          }
                        }}
                        autoFocus
                        rows={3}
                        maxLength={2_000}
                        placeholder="说明这里需要修改什么…"
                        className="block w-full resize-y rounded-md border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2 py-1.5 font-sans text-[11px] text-[var(--lm-text-primary)] outline-none placeholder:text-[var(--lm-text-muted)] focus:border-[var(--lm-accent)]"
                      />
                      <div className="mt-2 flex justify-end gap-1.5 font-sans">
                        <button
                          type="button"
                          onClick={() => setCommentTarget(null)}
                          className="rounded-md px-2 py-1 text-[10px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={saveComment}
                          disabled={!commentDraft.trim()}
                          className="rounded-md bg-[var(--lm-accent)] px-2 py-1 text-[10px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
                        >
                          保存评论
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {parsed.hunks.length === 0 && (
        <div className="px-4 py-8 text-center text-[11px] text-[var(--lm-text-muted)]">
          此文件没有可解析的文本代码块。
        </div>
      )}
    </section>
  )
}
