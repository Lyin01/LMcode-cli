/**
 * 轻量 ANSI / SGR 状态化解析器。
 *
 * 终端输出以流式 chunk 到达，SGR（Select Graphic Rendition）状态是
 * 持久的——`\x1B[31m` 设置前景色后，后续文本一直保持该颜色直到下一个
 * SGR 序列。因此解析必须跨 chunk 延续状态：每次 `push(text)` 返回的片段
 * 已固化颜色，渲染时不依赖运行时状态，chunk 合并/截断也不会错位。
 *
 * 支持：16 色 / 亮色、256 色、truecolor、加粗、重置。光标移动等非 SGR
 * CSI 序列直接丢弃（本面板是滚动日志视图，不模拟光标）。
 */
// oxlint-disable no-control-regex -- 解析 ANSI 转义序列需要匹配控制字符，属刻意为之。

export interface AnsiSegment {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
}

/** 终端 16 色标准色板（xterm 默认）。 */
const BASE16: readonly string[] = [
  '#000000', '#cc0000', '#4e9a06', '#c4a000',
  '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f',
  '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
]

const DANGEROUS_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g
const CSI = /^\u001B\[[0-?]*[ -/]*[@-~]/

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value))
}

function hexPair(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0')
}

function truecolorToHex(parts: readonly number[]): string | undefined {
  if (parts.length < 3) return undefined
  return `#${hexPair(parts[0]!)}${hexPair(parts[1]!)}${hexPair(parts[2]!)}`
}

function color256(index: number): string | undefined {
  if (index >= 0 && index < 16) return BASE16[index]!
  if (index >= 16 && index < 232) {
    const value = index - 16
    const r = Math.floor(value / 36)
    const g = Math.floor((value % 36) / 6)
    const b = value % 6
    const toByte = (component: number): number =>
      component === 0 ? 0 : 55 + component * 40
    return `#${hexPair(toByte(r))}${hexPair(toByte(g))}${hexPair(toByte(b))}`
  }
  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10
    return `#${hexPair(gray)}${hexPair(gray)}${hexPair(gray)}`
  }
  return undefined
}

export class AnsiStateParser {
  private fg: string | undefined
  private bg: string | undefined
  private bold = false
  /** 暂存的未完成 CSI 序列尾部（等待下一 chunk 补齐）。 */
  private pendingEscape = ''

  /** 应用一条 SGR 参数序列（`\x1B[...m` 中 `...` 部分）。 */
  private applySgr(params: readonly string[]): void {
    if (params.length === 0 || (params.length === 1 && params[0] === '')) {
      this.fg = undefined
      this.bg = undefined
      this.bold = false
      return
    }
    let i = 0
    while (i < params.length) {
      const raw = params[i]!
      const code = raw === '' ? 0 : Number.parseInt(raw, 10)
      if (Number.isNaN(code)) {
        i += 1
        continue
      }
      if (code === 0) {
        this.fg = undefined
        this.bg = undefined
        this.bold = false
      } else if (code === 1) {
        this.bold = true
      } else if (code === 22) {
        this.bold = false
      } else if (code >= 30 && code <= 37) {
        this.fg = BASE16[code - 30]
      } else if (code >= 90 && code <= 97) {
        this.fg = BASE16[code - 90 + 8]
      } else if (code === 39) {
        this.fg = undefined
      } else if (code >= 40 && code <= 47) {
        this.bg = BASE16[code - 40]
      } else if (code >= 100 && code <= 107) {
        this.bg = BASE16[code - 100 + 8]
      } else if (code === 49) {
        this.bg = undefined
      } else if (code === 38 || code === 48) {
        // Extended color: 38;5;n / 38;2;r;g;b (same for background 48).
        const isFg = code === 38
        const mode = Number.parseInt(params[i + 1] ?? '', 10)
        if (mode === 5) {
          const index = Number.parseInt(params[i + 2] ?? '', 10)
          if (Number.isInteger(index)) {
            const color = color256(index)
            if (color) {
              if (isFg) this.fg = color
              else this.bg = color
            }
          }
          i += 2
        } else if (mode === 2) {
          const color = truecolorToHex(
            params.slice(i + 2, i + 5).map((part) => Number.parseInt(part, 10)),
          )
          if (color) {
            if (isFg) this.fg = color
            else this.bg = color
          }
          i += 4
        }
      }
      i += 1
    }
  }

  /**
   * 解析一段终端文本为片段。解析器内部状态（颜色/加粗/待续转义）跨调用
   * 延续，调用方只需按到达顺序 push 每个 chunk。以未完成 CSI 序列结尾的
   * chunk 会把序列尾部暂存到下一 chunk，不会残留乱码。
   */
  push(text: string): AnsiSegment[] {
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replaceAll('\t', '    ')
    const full = this.pendingEscape + cleaned
    this.pendingEscape = ''

    // 找出末尾可能不完整的 CSI 序列：最后一个 ESC 之后的尾巴形如
    // `\x1B[...`（含参数/中间字节但未到终止字节）时暂存到下一 chunk。
    let parseEnd = full.length
    const lastEsc = full.lastIndexOf('\u001B')
    if (lastEsc !== -1) {
      const tail = full.slice(lastEsc)
      if (tail.length > 1 && /^\u001B\[[0-?]*[ -/]*$/.test(tail)) {
        this.pendingEscape = tail
        parseEnd = lastEsc
      }
    }

    const source = full.slice(0, parseEnd)
    const segments: AnsiSegment[] = []
    let buffer = ''
    let i = 0

    const flush = (): void => {
      const safe = buffer.replace(DANGEROUS_CONTROL, '')
      if (safe.length > 0) {
        segments.push({
          text: safe,
          ...(this.fg ? { fg: this.fg } : {}),
          ...(this.bg ? { bg: this.bg } : {}),
          ...(this.bold ? { bold: true } : {}),
        })
      }
      buffer = ''
    }

    while (i < source.length) {
      if (source[i] === '\u001B') {
        const rest = source.slice(i)
        const match = rest.match(CSI)
        if (match) {
          const sequence = match[0]
          const sgrMatch = /^\u001B\[([0-?]*[ -/]*)(m)$/.exec(sequence)
          if (sgrMatch) {
            flush()
            const params = sgrMatch[1]!.split(';')
            this.applySgr(params)
          }
          i += sequence.length
          continue
        }
        // 裸 ESC：丢弃，避免残留转义字符。
        flush()
        i += 1
        continue
      }
      buffer += source[i]!
      i += 1
    }
    flush()
    return segments
  }

  /** 重置为默认状态（新终端会话/清屏时调用）。 */
  reset(): void {
    this.fg = undefined
    this.bg = undefined
    this.bold = false
    this.pendingEscape = ''
  }
}

/** 提取终端文本的纯文本内容（去掉 ANSI 序列与控制字符），用于复制。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // 行尾裸 ESC 或未闭合的 CSI 序列（chunk 边界可能残留）。
    .replace(/\u001B(\[[0-?]*[ -/]*)?$/gm, '')
    // 行中孤立 ESC（后不接 CSI/OSC 起始字节）。
    .replace(/\u001B(?!\[|\])/g, '')
    .replace(DANGEROUS_CONTROL, '')
}
