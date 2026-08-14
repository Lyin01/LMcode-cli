/**
 * Markdown 顶层块切分：把文档内容拆成段落/标题/列表/代码块等顶层块，
 * 供 ArtifactPanel 逐块渲染和段落锚定评论使用。切分结果同时被
 * artifacts-store 用于内容更新后重锚评论，两处必须共用同一份实现，
 * 保证渲染块序号与锚点 blockIndex 严格一致。
 */

const OPEN_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/
const CLOSING_FENCE_PATTERN = /^(`+|~+)$/

/** 按空行切分顶层块；围栏代码块内部的空行不构成边界。 */
export function splitMarkdownBlocks(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fenceChar: string | null = null
  let fenceLength = 0

  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1]?.trim() === '') current.pop()
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
  }

  for (const line of lines) {
    if (fenceChar === null && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
    if (fenceChar === null) {
      const opening = line.match(OPEN_FENCE_PATTERN)
      if (opening?.[1]) {
        fenceChar = opening[1][0] ?? null
        fenceLength = opening[1].length
      }
    } else {
      const trimmed = line.trim()
      if (trimmed.startsWith(fenceChar.repeat(fenceLength)) && CLOSING_FENCE_PATTERN.test(trimmed)) {
        fenceChar = null
      }
    }
  }
  flush()
  return blocks
}

/** 锚点摘录：折叠空白后截断，用于内容更新后判断评论是否还对得上原段落。 */
export function blockExcerpt(block: string, maxLength = 60): string {
  const collapsed = block.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`
}
