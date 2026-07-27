import type { GitReviewComment } from '@/components/GitDiffView'

const SECTION_LABELS: Record<GitReviewComment['sectionKind'], string> = {
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪',
}

export function formatGitReviewComments(
  comments: readonly GitReviewComment[],
): string {
  const ordered = [...comments].sort((left, right) => {
    const pathOrder = left.filePath.localeCompare(right.filePath)
    if (pathOrder !== 0) return pathOrder
    return left.line - right.line
  })
  const items = ordered.map((comment) => {
    const side = comment.side === 'new' ? '新行' : '旧行'
    return `- \`${comment.filePath}:${comment.line}\`（${SECTION_LABELS[comment.sectionKind]} · ${side}）：${comment.body}`
  })
  return [
    '请根据以下代码审查意见修改当前工作区。先核对每条意见是否与现有代码一致，只处理确认成立的问题；完成后说明改动和验证结果。',
    '',
    ...items,
  ].join('\n')
}
