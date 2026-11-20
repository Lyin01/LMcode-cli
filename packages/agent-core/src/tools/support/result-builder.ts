import type {
  ExecutableToolErrorResult,
  ExecutableToolSuccessResult,
} from '../../loop/types';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

/**
 * Head-tail split threshold.
 *
 * Below this size the builder uses the legacy prefix-truncation strategy
 * (keep first N chars, drop the rest).  At or above it, the builder
 * switches to head–tail retention: the first ~55 % of the limit becomes
 * the "head", the last ~40 % becomes a ring-buffer "tail", and the final
 * output stitches them together with a truncation marker in the middle.
 *
 * This way a 50 KB build log preserves both the early output and the
 * tail errors the LLM actually cares about.
 */
const HEAD_TAIL_MIN_CHARS = 2000;
const HEAD_RATIO = 0.55;
const TAIL_RATIO = 0.40;

export interface ToolResultBuilderOptions {
  readonly maxChars?: number;
  readonly maxLineLength?: number | null;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolSuccessResult
  | ExecutableToolErrorResult
) & {
  readonly output: string;
  readonly message: string;
  readonly truncated: boolean;
  readonly brief?: string;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxLineLength: number | null;

  /** Whether to use head-tail truncation (true) or legacy prefix truncation. */
  private readonly useHeadTail: boolean;
  private readonly headMaxChars: number;
  private readonly tailMaxChars: number;

  // ── Legacy state ────────────────────────────────────────────────────
  private readonly buffer: string[] = [];
  private nCharsValue = 0;
  private truncationHappened = false;

  // ── Head-tail state ─────────────────────────────────────────────────
  // Keep ordinary output intact. Only allocate a tail window after overflow.
  private head = '';
  private tail?: Buffer;
  private tailCursor = 0;
  private totalBytes = 0;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;

    this.useHeadTail = this.maxChars >= HEAD_TAIL_MIN_CHARS;
    this.headMaxChars = Math.floor(this.maxChars * HEAD_RATIO);
    this.tailMaxChars = Math.floor(this.maxChars * TAIL_RATIO);

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new Error('maxLineLength must be greater than the truncation marker length.');
    }
  }

  get nChars(): number {
    return this.useHeadTail ? this.head.length + (this.tail ? this.tailMaxChars : 0) : this.nCharsValue;
  }

  write(text: string): number {
    if (text.length === 0) return 0;
    if (this.useHeadTail) return this.writeHeadTail(this.clipLongLines(text));

    let charsWritten = 0;
    for (const line of text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? []) {
      charsWritten += this.writeLegacyLine(line);
    }
    return charsWritten;
  }

  // ── Legacy (prefix-only) strategy ───────────────────────────────────

  private writeLegacyLine(line: string): number {
    if (this.nCharsValue >= this.maxChars) {
      if (line.length > 0 && !this.truncationHappened) {
        this.buffer.push(TRUNCATION_MARKER);
        this.nCharsValue += TRUNCATION_MARKER.length;
        this.truncationHappened = true;
      }
      return 0;
    }

    const remainingChars = this.maxChars - this.nCharsValue;
    const limit =
      this.maxLineLength === null
        ? remainingChars
        : Math.min(remainingChars, this.maxLineLength);
    let processedLine = line;
    if (processedLine.length > limit) {
      const lineBreak = /[\r\n]+$/.exec(processedLine)?.[0] ?? '';
      const suffix = TRUNCATION_MARKER + lineBreak;
      const effectiveMaxLength = Math.max(limit, suffix.length);
      processedLine = processedLine.slice(0, effectiveMaxLength - suffix.length) + suffix;
      this.truncationHappened = true;
    }

    this.buffer.push(processedLine);
    const written = processedLine.length;
    this.nCharsValue += written;
    return written;
  }

  // ── Head-tail strategy ──────────────────────────────────────────────

  private clipLongLines(text: string): string {
    const limit = this.maxLineLength;
    if (limit === null || text.length <= limit) return text;
    const breaks = /\r\n|[\r\n]/g;
    let lineStart = 0;
    let copiedThrough = 0;
    let clipped = '';
    while (lineStart + limit < text.length) {
      let end = lineStart + limit;
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
      // Every complete line in this window fits. Skip them together without
      // materializing a match or a string-array entry for every short line.
      const window = text.slice(lineStart, end);
      const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('\r'));
      if (lastBreak >= 0) {
        lineStart += lastBreak + 1;
        continue;
      }
      breaks.lastIndex = end;
      const delimiter = breaks.exec(text);
      const lineBreak = delimiter?.[0] ?? '';
      const keep = Math.max(0, limit - TRUNCATION_MARKER.length - lineBreak.length);
      clipped += text.slice(copiedThrough, lineStart + keep) + TRUNCATION_MARKER + lineBreak;
      copiedThrough = delimiter ? breaks.lastIndex : text.length;
      lineStart = copiedThrough;
      this.truncationHappened = true;
    }
    return copiedThrough ? clipped + text.slice(copiedThrough) : text;
  }

  private writeHeadTail(text: string): number {
    if (!this.tail) {
      if (this.head.length + text.length <= this.maxChars) {
        this.head += text;
        return text.length;
      }
      const previous = this.head;
      const prefix = previous.slice(0, this.headMaxChars) +
        text.slice(0, Math.max(0, this.headMaxChars - previous.length));
      // Own the prefix so a substring cannot keep a whole input chunk alive.
      this.head = Buffer.from(prefix, 'utf16le').toString('utf16le');
      this.tail = Buffer.alloc(this.tailMaxChars * 2);
      this.appendTail(this.tail, previous);
      this.totalBytes = Buffer.byteLength(previous);
      this.truncationHappened = true;
    }
    this.appendTail(this.tail, text);
    this.totalBytes += Buffer.byteLength(text);
    return text.length;
  }

  private appendTail(tail: Buffer, text: string): void {
    if (text.length >= this.tailMaxChars) {
      tail.write(text.slice(-this.tailMaxChars), 0, 'utf16le');
      this.tailCursor = 0;
      return;
    }
    const firstLength = Math.min(this.tailMaxChars - this.tailCursor, text.length);
    tail.write(text, this.tailCursor * 2, firstLength * 2, 'utf16le');
    if (firstLength < text.length) tail.write(text.slice(firstLength), 0, 'utf16le');
    this.tailCursor = (this.tailCursor + text.length) % this.tailMaxChars;
  }

  // ── Output assembly ─────────────────────────────────────────────────

  ok(message = '', options: { readonly brief?: string } = {}): ExecutableToolResultBuilderResult {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    if (this.truncationHappened) {
      finalMessage =
        finalMessage.length === 0 ? TRUNCATION_MESSAGE : `${finalMessage} ${TRUNCATION_MESSAGE}`;
    }

    const output = this.assembleOutput();
    const shouldAppendMessage =
      finalMessage.length > 0 && (this.truncationHappened || output.length === 0);
    return {
      isError: false,
      output: shouldAppendMessage
        ? output.length === 0
          ? finalMessage
          : output.endsWith('\n')
            ? `${output}${finalMessage}`
            : `${output}\n${finalMessage}`
        : output,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }

  error(
    message: string,
    options: { readonly brief?: string } = {},
  ): ExecutableToolResultBuilderResult {
    const finalMessage = this.truncationHappened
      ? message.length === 0
        ? TRUNCATION_MESSAGE
        : `${message} ${TRUNCATION_MESSAGE}`
      : message;
    const output = this.assembleOutput();
    return {
      isError: true,
      output:
        finalMessage.length === 0
          ? output
          : output.length === 0
            ? finalMessage
            : output.endsWith('\n')
              ? `${output}${finalMessage}`
              : `${output}\n${finalMessage}`,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }

  /**
   * Assemble the final output string.
   *
   * In head-tail mode with truncation, this produces:
   *   [head content]
   *   [...truncated N KB...]
   *   [tail content]
   *
   * Otherwise it returns the raw buffer.
   */
  private assembleOutput(): string {
    if (!this.useHeadTail) {
      return this.buffer.join('');
    }
    if (!this.tail) return this.head;
    const offset = this.tailCursor * 2;
    const head = this.head.replace(/[\uD800-\uDBFF]$/, '');
    const tail = (this.tail.toString('utf16le', offset) + this.tail.toString('utf16le', 0, offset))
      .replace(/^[\uDC00-\uDFFF]/, '');
    const omittedBytes = this.totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
    const marker = this.formatTruncatedMarker(omittedBytes);

    if (head.length > 0 && !head.endsWith('\n')) {
      return `${head}\n${marker}\n${tail}`;
    }
    return `${head}${marker}\n${tail}`;
  }

  private formatTruncatedMarker(byteCount: number): string {
    if (byteCount < 1024) {
      return `${TRUNCATION_MARKER} ${String(byteCount)} B`;
    }
    if (byteCount < 1024 * 1024) {
      return `${TRUNCATION_MARKER} ${(byteCount / 1024).toFixed(1)} KB`;
    }
    return `${TRUNCATION_MARKER} ${(byteCount / (1024 * 1024)).toFixed(1)} MB`;
  }
}
