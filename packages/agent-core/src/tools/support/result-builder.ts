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
  private readonly headBuffer: string[] = [];
  private readonly tailRingBuffer: string[] = [];
  private nCharsHead = 0;
  private nCharsTail = 0;
  /** Total characters ever fed into write() — used for the marker. */
  private totalInputChars = 0;
  private headFull = false;

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
    return this.useHeadTail ? this.nCharsHead + this.nCharsTail : this.nCharsValue;
  }

  write(text: string): number {
    if (this.useHeadTail) {
      return this.writeImpl(text, this.writeHeadTailLine.bind(this));
    }
    return this.writeImpl(text, this.writeLegacyLine.bind(this));
  }

  // ── write dispatch ──────────────────────────────────────────────────

  private writeImpl(
    text: string,
    writeLine: (line: string) => number,
  ): number {
    if (text.length === 0) return 0;

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    let charsWritten = 0;
    for (const originalLine of lines) {
      charsWritten += writeLine(originalLine);
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

  private writeHeadTailLine(line: string): number {
    if (!this.headFull) {
      const remainingHead = this.headMaxChars - this.nCharsHead;
      if (remainingHead <= 0) {
        this.headFull = true;
      } else {
        const limit =
          this.maxLineLength === null
            ? remainingHead
            : Math.min(remainingHead, this.maxLineLength);
        let processedLine = line;
        if (processedLine.length > limit) {
          const lineBreak = /[\r\n]+$/.exec(processedLine)?.[0] ?? '';
          const suffix = TRUNCATION_MARKER + lineBreak;
          const effectiveMaxLength = Math.max(limit, suffix.length);
          processedLine = processedLine.slice(0, effectiveMaxLength - suffix.length) + suffix;
          this.truncationHappened = true;
        }

        this.headBuffer.push(processedLine);
        this.nCharsHead += processedLine.length;
        this.totalInputChars += line.length;

        if (this.nCharsHead >= this.headMaxChars) {
          this.headFull = true;
        }
        return processedLine.length;
      }
    }

    // ── Writing to tail ring buffer ───────────────────────────────
    this.totalInputChars += line.length;

    const limit =
      this.maxLineLength === null ? Infinity : this.maxLineLength;
    let processedLine = line;
    if (processedLine.length > limit) {
      const lineBreak = /[\r\n]+$/.exec(processedLine)?.[0] ?? '';
      const suffix = TRUNCATION_MARKER + lineBreak;
      const effectiveMaxLength = Math.max(limit, suffix.length);
      processedLine = processedLine.slice(0, effectiveMaxLength - suffix.length) + suffix;
    }

    this.tailRingBuffer.push(processedLine);
    this.nCharsTail += processedLine.length;
    this.truncationHappened = true;

    // Drop oldest lines from the tail ring buffer, keeping at least one
    // line so the tail always has content even when a single line exceeds
    // tailMaxChars.
    while (this.nCharsTail > this.tailMaxChars && this.tailRingBuffer.length > 1) {
      const dropped = this.tailRingBuffer.shift()!;
      this.nCharsTail -= dropped.length;
    }

    return processedLine.length;
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
    if (this.tailRingBuffer.length === 0) {
      return this.headBuffer.join('');
    }

    const head = this.headBuffer.join('');
    const tail = this.tailRingBuffer.join('');

    // Everything that entered the builder but is no longer held in the head
    // or tail buffers was lost to ring-buffer eviction; that single difference
    // already accounts for input beyond maxChars, so no extra term is needed.
    const bufferedTotal = this.nCharsHead + this.nCharsTail;
    const lostToOverflow = Math.max(0, this.totalInputChars - bufferedTotal);

    if (lostToOverflow <= 0) {
      // No data was lost — head just filled and tail continues.
      return head + tail;
    }

    const marker = this.formatTruncatedMarker(lostToOverflow);

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
