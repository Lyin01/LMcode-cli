import { describe, expect, it } from 'vitest'
import { blockExcerpt, splitMarkdownBlocks } from '@/lib/markdown-blocks'

describe('markdown block splitting', () => {
  it('splits top-level blocks on blank lines', () => {
    expect(splitMarkdownBlocks('# 标题\n\n第一段\n\n- a\n- b')).toEqual([
      '# 标题',
      '第一段',
      '- a\n- b',
    ])
  })

  it('keeps fenced code blocks together even when they contain blank lines', () => {
    const content = '前文\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n后文'
    expect(splitMarkdownBlocks(content)).toEqual([
      '前文',
      '```ts\nconst a = 1\n\n\nconst b = 2\n```',
      '后文',
    ])
  })

  it('normalizes CRLF and drops trailing blank lines', () => {
    expect(splitMarkdownBlocks('一段\r\n\r\n二段\r\n\r\n')).toEqual(['一段', '二段'])
  })

  it('collapses whitespace in excerpts and truncates long blocks', () => {
    expect(blockExcerpt('第一行\n  第二行')).toBe('第一行 第二行')
    const excerpt = blockExcerpt('字'.repeat(100))
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBe(61)
  })
})
