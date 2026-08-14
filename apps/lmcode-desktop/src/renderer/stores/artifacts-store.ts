import { create } from 'zustand'
import { blockExcerpt, splitMarkdownBlocks } from '@/lib/markdown-blocks'

/**
 * Artifacts 工件：agent 产出的结构化文档（plan 计划 / report 报告）。
 * 文档承载段落锚定评论，评论可组装成反馈发回会话继续迭代。
 * 只在页面生命周期内有效，不持久化到磁盘。
 */

export type ArtifactKind = 'plan' | 'report'

export interface ArtifactAnchor {
  /** 顶层块序号，与 splitMarkdownBlocks 的切分顺序一一对应。 */
  readonly blockIndex: number
  /** 锚点摘录：内容更新后用它判断评论是否还能对上原段落。 */
  readonly excerpt: string
}

export interface ArtifactComment {
  readonly id: string
  readonly anchor: ArtifactAnchor
  readonly text: string
  readonly createdAt: number
  /** 内容更新后锚不上的评论标记为过期，不删除、不参与反馈组装。 */
  readonly outdated: boolean
}

export interface Artifact {
  readonly id: string
  readonly sessionId: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
  readonly comments: readonly ArtifactComment[]
  /** 产生该文档的工具调用 id，聊天流里据此挂「打开文档审阅」入口。 */
  readonly toolCallIds: readonly string[]
}

export interface ArtifactUpsertInput {
  readonly sessionId: string
  readonly kind: ArtifactKind
  /** 稳定身份键：plan 固定为 'plan'；report 用规范化文件路径。 */
  readonly key: string
  readonly title: string
  readonly content: string
  readonly toolCallId?: string
  /** Write mode=append 时拼接到现有内容末尾，而不是整体替换。 */
  readonly append?: boolean
}

let artifactCommentCounter = 0
function nextCommentId(): string {
  artifactCommentCounter += 1
  return `artifact_comment_${Date.now()}_${artifactCommentCounter}`
}

/** 内容更新后重锚：块序号越界或摘录对不上的评论标记为过期（不删除）。 */
function reanchorComments(
  comments: readonly ArtifactComment[],
  content: string,
): ArtifactComment[] {
  const blocks = splitMarkdownBlocks(content)
  let changed = false
  const next = comments.map((comment) => {
    const block = blocks[comment.anchor.blockIndex]
    const outdated = block === undefined || blockExcerpt(block) !== comment.anchor.excerpt
    if (outdated === comment.outdated) return comment
    changed = true
    return { ...comment, outdated }
  })
  return changed ? next : [...comments]
}

export interface ArtifactsStore {
  readonly artifacts: readonly Artifact[]
  /** 当前在审阅面板中打开的 artifact id；null 表示面板关闭。 */
  readonly panelArtifactId: string | null
  /** 新建或更新（版本 +1、刷新内容、重锚评论）。返回落库后的条目。 */
  upsert: (input: ArtifactUpsertInput) => Artifact
  addComment: (artifactId: string, anchor: ArtifactAnchor, text: string) => void
  removeComment: (artifactId: string, commentId: string) => void
  openPanel: (artifactId: string) => void
  closePanel: () => void
}

export const useArtifactsStore = create<ArtifactsStore>((set, get) => ({
  artifacts: [],
  panelArtifactId: null,

  upsert: (input) => {
    const id = `${input.kind}:${input.sessionId}:${input.key}`
    const existing = get().artifacts.find((artifact) => artifact.id === id)
    const now = Date.now()
    let artifact: Artifact
    if (existing) {
      const content = input.append ? existing.content + input.content : input.content
      artifact = {
        ...existing,
        title: input.title,
        content,
        updatedAt: now,
        version: existing.version + 1,
        comments: reanchorComments(existing.comments, content),
        toolCallIds:
          input.toolCallId !== undefined && !existing.toolCallIds.includes(input.toolCallId)
            ? [...existing.toolCallIds, input.toolCallId]
            : existing.toolCallIds,
      }
      set((state) => ({
        artifacts: state.artifacts.map((entry) => (entry.id === id ? artifact : entry)),
      }))
    } else {
      artifact = {
        id,
        sessionId: input.sessionId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        createdAt: now,
        updatedAt: now,
        version: 1,
        comments: [],
        toolCallIds: input.toolCallId !== undefined ? [input.toolCallId] : [],
      }
      set((state) => ({ artifacts: [...state.artifacts, artifact] }))
    }
    return artifact
  },

  addComment: (artifactId, anchor, text) => {
    const comment: ArtifactComment = {
      id: nextCommentId(),
      anchor,
      text,
      createdAt: Date.now(),
      outdated: false,
    }
    set((state) => ({
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === artifactId
          ? // 立即按当前内容判定一次，越界锚点直接过期，不等到下次更新。
            { ...artifact, comments: reanchorComments([...artifact.comments, comment], artifact.content) }
          : artifact,
      ),
    }))
  },

  removeComment: (artifactId, commentId) =>
    set((state) => ({
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === artifactId
          ? { ...artifact, comments: artifact.comments.filter((c) => c.id !== commentId) }
          : artifact,
      ),
    })),

  openPanel: (artifactId) => set({ panelArtifactId: artifactId }),

  closePanel: () => set({ panelArtifactId: null }),
}))

/** 聊天流工具卡片用：该工具调用是否产出了可审阅文档。 */
export function artifactIdForToolCall(
  artifacts: readonly Artifact[],
  toolCallId: string,
): string | null {
  for (const artifact of artifacts) {
    if (artifact.toolCallIds.includes(toolCallId)) return artifact.id
  }
  return null
}

/** 参与反馈组装的未过期评论数。 */
export function activeCommentCount(artifact: Artifact): number {
  let count = 0
  for (const comment of artifact.comments) {
    if (!comment.outdated) count += 1
  }
  return count
}
