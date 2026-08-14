import { describe, expect, it } from 'vitest'
import { formatArtifactComments } from '@/lib/artifact-comments'
import type { ArtifactComment } from '@/stores/artifacts-store'

function comment(blockIndex: number, excerpt: string, text: string, outdated = false): ArtifactComment {
  return {
    id: `c-${blockIndex}`,
    anchor: { blockIndex, excerpt },
    text,
    createdAt: 0,
    outdated,
  }
}

describe('artifact comment prompt', () => {
  it('quotes each anchored block and keeps paragraph order deterministic', () => {
    const prompt = formatArtifactComments({ kind: 'plan', title: 'plan.md' }, [
      comment(2, '第三步：验证', '验证步骤要包含类型检查。'),
      comment(0, '第一步：改动', '这里需要保留取消语义。'),
    ])

    expect(prompt).toContain('请根据以下对计划「plan.md」的审阅意见修改')
    expect(prompt).toContain('只处理确认成立的问题')
    expect(prompt).toContain('- 第 1 段「第一步：改动」：这里需要保留取消语义。')
    expect(prompt).toContain('- 第 3 段「第三步：验证」：验证步骤要包含类型检查。')
    expect(prompt.indexOf('第 1 段')).toBeLessThan(prompt.indexOf('第 3 段'))
  })

  it('excludes outdated comments from the feedback', () => {
    const prompt = formatArtifactComments({ kind: 'report', title: 'report.md' }, [
      comment(0, '引言', '仍然有效'),
      comment(1, '旧段落', '已过期意见', true),
    ])

    expect(prompt).toContain('仍然有效')
    expect(prompt).not.toContain('已过期意见')
    expect(prompt).toContain('对文档「report.md」的审阅意见')
  })
})
