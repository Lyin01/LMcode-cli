import { describe, expect, it } from 'vitest'
import { formatGitReviewComments } from '../src/renderer/lib/git-review-comments'

describe('Git review comment prompt', () => {
  it('keeps file and line references explicit and deterministic', () => {
    const prompt = formatGitReviewComments([
      {
        id: 'two',
        filePath: 'src/z.ts',
        sectionKind: 'staged',
        line: 8,
        side: 'old',
        body: '不要吞掉这个错误。',
      },
      {
        id: 'one',
        filePath: 'src/a.ts',
        sectionKind: 'unstaged',
        line: 14,
        side: 'new',
        body: '这里需要保留取消语义。',
      },
    ])

    expect(prompt).toContain('只处理确认成立的问题')
    expect(prompt.indexOf('src/a.ts:14')).toBeLessThan(prompt.indexOf('src/z.ts:8'))
    expect(prompt).toContain('`src/a.ts:14`（未暂存 · 新行）：这里需要保留取消语义。')
    expect(prompt).toContain('`src/z.ts:8`（已暂存 · 旧行）：不要吞掉这个错误。')
  })
})
