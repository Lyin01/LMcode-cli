import { describe, expect, it } from 'vitest'
import { toolFamily, summarizeToolArgs, summarizeToolResult } from '../src/renderer/lib/tool-summary'

describe('tool-summary', () => {
  it('classifies the DeepSeek anchor str_replace_editor by its command argument', () => {
    expect(toolFamily('str_replace_editor', JSON.stringify({ command: 'view', path: 'a.ts' }))).toBe('read')
    expect(toolFamily('str_replace_editor', JSON.stringify({ command: 'create', path: 'a.ts' }))).toBe('write')
    expect(toolFamily('str_replace_editor', JSON.stringify({ command: 'str_replace', path: 'a.ts' }))).toBe('edit')
    expect(toolFamily('Bash', JSON.stringify({ command: 'ls' }))).toBe('bash')
    expect(toolFamily('Grep', undefined)).toBe('search')
  })

  it('summarizes bash args by the last meaningful segment, skipping cd prefixes', () => {
    const args = JSON.stringify({ command: 'cd /e/repo && git status && git log --oneline -5\n' })
    expect(summarizeToolArgs('Bash', args)).toBe('git log --oneline -5')
  })

  it('survives partially streamed (invalid JSON) args', () => {
    expect(summarizeToolArgs('Bash', '{"command":"git sta')).toBe('git sta')
    expect(toolFamily('Read', '{"path":"src/a.ts')).toBe('read')
  })

  it('derives outcome summaries from results once the call finishes', () => {
    expect(summarizeToolResult('Read', JSON.stringify({ path: 'a.ts' }), '1\ta\n2\tb\n3\tc\n', false)).toBe('3 行')
    expect(summarizeToolResult('Bash', undefined, 'ok\nok\n', false)).toBe('2 行输出')
    expect(summarizeToolResult('Bash', undefined, '', false)).toBe('无输出')
    expect(
      summarizeToolResult('Grep', JSON.stringify({ pattern: 'x' }), 'src/a.ts:1:xx\nsrc/b.ts:7:xx\n', false),
    ).toBe('2 个结果')
    expect(summarizeToolResult('Write', JSON.stringify({ path: 'a.ts', content: 'a\nb\nc' }), '已写入', false)).toBe('写入 3 行')
    expect(summarizeToolResult('Edit', JSON.stringify({ path: 'a.ts' }), 'done', false)).toBe('已更新')
  })

  it('keeps failure output readable and falls back to args when there is no result', () => {
    expect(summarizeToolResult('Bash', JSON.stringify({ command: 'npm test' }), 'Command failed with exit code: 1.\n', true)).toBe(
      'Command failed with exit code: 1.',
    )
    expect(summarizeToolResult('Read', JSON.stringify({ path: 'src/a.ts' }), undefined, false)).toBeUndefined()
    expect(summarizeToolArgs('Read', JSON.stringify({ path: 'E:/repo/src/a.ts' }))).toBe('src/a.ts')
  })
})
