import { describe, expect, it } from 'vitest'
import { AnsiStateParser, stripAnsi } from '../src/renderer/lib/ansi'

function plain(segments: ReturnType<AnsiStateParser['push']>): string {
  return segments.map((s) => s.text).join('')
}

describe('AnsiStateParser', () => {
  it('passes plain text through unchanged', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('hello world\n')
    expect(plain(segments)).toBe('hello world\n')
    expect(segments[0]).not.toHaveProperty('fg')
  })

  it('applies a foreground color to following text', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('\u001B[31mred\u001B[0mplain')
    expect(plain(segments)).toBe('redplain')
    expect(segments[0]!.fg).toBe('#cc0000')
    expect(segments[0]!.text).toBe('red')
    expect(segments[1]).not.toHaveProperty('fg')
    expect(segments[1]!.text).toBe('plain')
  })

  it('keeps SGR state across separate pushes (streaming chunks)', () => {
    const parser = new AnsiStateParser()
    parser.push('\u001B[32m')
    const segments = parser.push('green')
    parser.push('\u001B[0m')
    const after = parser.push('default')
    expect(segments[0]!.fg).toBe('#4e9a06')
    expect(segments[0]!.text).toBe('green')
    expect(after[0]).not.toHaveProperty('fg')
  })

  it('handles bright colors (90-97) and bold', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('\u001B[1;91mbold bright red\u001B[0m')
    expect(segments[0]!.bold).toBe(true)
    expect(segments[0]!.fg).toBe('#ef2929')
  })

  it('resolves 256-color palette indices', () => {
    const parser = new AnsiStateParser()
    // 38;5;196 -> red (16..231 range: 196-16=180, r=5,g=0,b=0)
    const segments = parser.push('\u001B[38;5;196mx\u001B[0m')
    expect(segments[0]!.fg).toBe('#ff0000')
  })

  it('resolves truecolor (38;2;r;g;b)', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('\u001B[38;2;255;128;0mx\u001B[0m')
    expect(segments[0]!.fg).toBe('#ff8000')
  })

  it('buffers an incomplete CSI sequence across chunk boundaries', () => {
    const parser = new AnsiStateParser()
    const first = parser.push('ab\u001B[3')
    expect(first.map((s) => s.text).join('')).toBe('ab')
    // 序列尾部被暂存，不会渲染出 "[3" 残留
    const second = parser.push('1mred\u001B[0m')
    expect(plain(second)).toBe('red')
    expect(second[0]!.fg).toBe('#cc0000')
  })

  it('drops lone escape characters', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('a\u001Bb')
    expect(plain(segments)).toBe('ab')
  })

  it('drops cursor-movement CSI sequences (non-SGR)', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('line\u001B[2Kclear')
    expect(plain(segments)).toBe('lineclear')
  })

  it('normalizes CRLF and tabs, strips dangerous control characters', () => {
    const parser = new AnsiStateParser()
    const segments = parser.push('a\r\nb\tc\u0007')
    expect(plain(segments)).toBe('a\nb    c')
  })

  it('resets all state via reset()', () => {
    const parser = new AnsiStateParser()
    parser.push('\u001B[1;33m')
    parser.reset()
    const segments = parser.push('text')
    expect(segments[0]).not.toHaveProperty('fg')
    expect(segments[0]).not.toHaveProperty('bold')
  })
})

describe('stripAnsi', () => {
  it('removes ANSI sequences but keeps text', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m plain')).toBe('red plain')
  })

  it('handles incomplete sequences', () => {
    expect(stripAnsi('x\u001B[3')).toBe('x')
  })

  it('removes OSC sequences', () => {
    expect(stripAnsi('a\u001B]0;title\u0007b')).toBe('ab')
  })
})
