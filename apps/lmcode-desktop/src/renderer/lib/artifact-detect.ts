import type { Event, ToolCallStartedEvent } from '@lmcode-cli/lmcode-sdk'
import type { ArtifactKind } from '@/stores/artifacts-store'

/**
 * Artifact 检测：从原始会话事件流里识别 agent 产出的可审阅文档。
 *
 * 数据源（v1）：
 * - plan：ExitPlanMode 的 tool.call.started 事件。agent-core 在呈现计划
 *   时通过 display（kind='plan_review'）携带完整计划文本与计划文件路径，
 *   不需要回读文件系统，是最干净的来源。用户要求修订时 agent 会再次调用
 *   ExitPlanMode，同一 artifact 自然版本 +1。
 * - report：Write 工具写出的 .md/.markdown 文件。参数里直接带完整内容；
 *   为避免审批拒绝/写失败产生幽灵文档，由 artifact-feed 关联到成功的
 *   tool.result 后才真正落库。
 *
 * Goal 验收标准文本未采用：goal.updated 事件不携带结构化文档内容，
 * 强行拼接待审阅文档会引入脆弱的格式假设。
 */

export interface ArtifactDetection {
  readonly kind: ArtifactKind
  /** 稳定身份键：plan 固定 'plan'；report 用规范化路径。 */
  readonly key: string
  readonly title: string
  readonly content: string
  readonly toolCallId: string
  readonly append: boolean
}

const MARKDOWN_PATH_PATTERN = /\.(md|markdown)$/i

function pathBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.at(-1) ?? path
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/')
}

interface WriteArgsShape {
  readonly path?: unknown
  readonly content?: unknown
  readonly mode?: unknown
}

function detectPlanArtifact(event: ToolCallStartedEvent): ArtifactDetection | null {
  if (event.name !== 'ExitPlanMode') return null
  const display = event.display
  if (display?.kind !== 'plan_review') return null
  if (display.plan.trim().length === 0) return null
  return {
    kind: 'plan',
    key: 'plan',
    title: display.path ? pathBasename(display.path) : '实施计划',
    content: display.plan,
    toolCallId: event.toolCallId,
    append: false,
  }
}

function detectReportArtifact(event: ToolCallStartedEvent): ArtifactDetection | null {
  if (event.name !== 'Write') return null
  if (typeof event.args !== 'object' || event.args === null) return null
  const args = event.args as WriteArgsShape
  if (typeof args.path !== 'string' || !MARKDOWN_PATH_PATTERN.test(args.path)) return null
  if (typeof args.content !== 'string' || args.content.trim().length === 0) return null
  return {
    kind: 'report',
    key: normalizePathKey(args.path),
    title: pathBasename(args.path),
    content: args.content,
    toolCallId: event.toolCallId,
    append: args.mode === 'append',
  }
}

/** 从 tool.call.started 事件识别 artifact；非 artifact 事件返回 null。 */
export function detectArtifactStart(event: Event): ArtifactDetection | null {
  if (event.type !== 'tool.call.started') return null
  return detectPlanArtifact(event) ?? detectReportArtifact(event)
}
