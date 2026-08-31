import { describe, expect, it } from 'vitest'
import { parseStdioCommandLine, tokenizeCommandLine } from '../src/renderer/lib/mcp-stdio-command'

describe('parseStdioCommandLine', () => {
  it('splits the documented npx placeholder into command + args', () => {
    expect(parseStdioCommandLine('npx -y @foo/mcp')).toEqual({
      command: 'npx',
      args: ['-y', '@foo/mcp'],
    })
  })

  it('keeps a single token as command with no args', () => {
    expect(parseStdioCommandLine('  uvx  ')).toEqual({
      command: 'uvx',
      args: [],
    })
  })

  it('preserves a quoted Windows path with spaces', () => {
    expect(
      parseStdioCommandLine('"C:\\Program Files\\nodejs\\npx.cmd" -y @scope/server'),
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\npx.cmd',
      args: ['-y', '@scope/server'],
    })
  })

  it('treats escaped quotes inside a quoted token as literals', () => {
    expect(tokenizeCommandLine(String.raw`"say \"hi\"" --flag`)).toEqual(['say "hi"', '--flag'])
  })

  it('rejects a blank command', () => {
    expect(() => parseStdioCommandLine('   \t  ')).toThrow(/不能为空/)
  })

  it('rejects an unclosed quote', () => {
    expect(() => parseStdioCommandLine('"C:\\Program Files\\npx -y foo')).toThrow(/引号未闭合/)
  })
})
