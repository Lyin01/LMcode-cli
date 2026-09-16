/**
 * Character budget shared by the document extractors. Extracted text is
 * appended in chunks and capped at the same byte budget the plain-text
 * attachment reader uses, so a huge workbook or PDF cannot flood a prompt.
 */
export class TextBudget {
  private readonly chunks: string[] = []
  private bytes = 0
  private full = false

  constructor(private readonly maxBytes: number) {}

  get isFull(): boolean {
    return this.full
  }

  /** Last emitted character, used by the docx scanner to avoid duplicate line breaks. */
  get lastChar(): string {
    const last = this.chunks[this.chunks.length - 1]
    return last === undefined || last.length === 0 ? '' : last.slice(-1)
  }

  append(text: string): void {
    if (this.full || text.length === 0) return
    let chunk = text
    if (this.bytes + utf8Length(text) > this.maxBytes) {
      chunk = truncateToByteBudget(text, this.maxBytes - this.bytes)
      this.full = true
    }
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += utf8Length(chunk)
  }

  toString(): string {
    return this.chunks.join('')
  }
}

function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < 0x80) bytes += 1
    else if (codePoint < 0x800) bytes += 2
    else if (codePoint < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

function truncateToByteBudget(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    const size =
      codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}
