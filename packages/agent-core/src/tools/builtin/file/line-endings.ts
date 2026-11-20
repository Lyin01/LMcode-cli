import { createHash } from 'node:crypto';

export type LineEndingStyle = 'lf' | 'crlf' | 'mixed';

export interface ModelTextView {
  text: string;
  lineEndingStyle: LineEndingStyle;
}

export function detectLineEndingStyle(text: string): LineEndingStyle {
  if (!text.includes('\r')) return 'lf';
  // After finding a CR, a lone CR or LF distinguishes mixed text from pure CRLF.
  return /\r(?!\n)|(?<!\r)\n/.test(text) ? 'mixed' : 'crlf';
}

export function toModelTextView(raw: string): ModelTextView {
  const lineEndingStyle = detectLineEndingStyle(raw);
  if (lineEndingStyle !== 'crlf') {
    return { text: raw, lineEndingStyle };
  }

  return {
    text: raw.replaceAll('\r\n', '\n'),
    lineEndingStyle,
  };
}

export function materializeModelText(text: string, lineEndingStyle: LineEndingStyle): string {
  if (lineEndingStyle !== 'crlf') return text;
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
}

export function makeCarriageReturnsVisible(text: string): string {
  return text.replaceAll('\r', '\\r');
}

export function computeAnchor(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}
