import type { Artifact, ArtifactComment } from '@/stores/artifacts-store'

/**
 * 把 artifact 的段落评论组装成反馈文本，注入会话 composer。
 * 格式对齐 git-review-comments：引导语 + 空行 + 定位明确的条目列表；
 * 只包含未过期评论，按锚点块序号排序保证输出确定。
 */
export function formatArtifactComments(
  artifact: Pick<Artifact, 'kind' | 'title'>,
  comments: readonly ArtifactComment[],
): string {
  const active = comments
    .filter((comment) => !comment.outdated)
    .sort((left, right) => left.anchor.blockIndex - right.anchor.blockIndex)
  const kindLabel = artifact.kind === 'plan' ? '计划' : '文档'
  const items = active.map(
    (comment) =>
      `- 第 ${comment.anchor.blockIndex + 1} 段「${comment.anchor.excerpt}」：${comment.text}`,
  )
  return [
    `请根据以下对${kindLabel}「${artifact.title}」的审阅意见修改。先核对每条意见是否与当前内容一致，只处理确认成立的问题；完成后说明改动和验证结果。`,
    '',
    ...items,
  ].join('\n')
}
