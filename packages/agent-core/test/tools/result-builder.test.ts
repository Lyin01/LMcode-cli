import { describe, expect, it } from 'vitest';

import { ToolResultBuilder } from '../../src/tools/support/result-builder';

describe('ToolResultBuilder', () => {
  it('returns concatenated output and a confirmation message under the limit', () => {
    const builder = new ToolResultBuilder({ maxChars: 50 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(6);

    const result = builder.ok('Operation completed');
    expect(result.output).toBe('Hello world');
    expect(result.message).toBe('Operation completed.');
    expect(builder.nChars).toBe(11);
  });

  it('truncates with marker at the cut point and appends the message after', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world!')).toBe(14);
    expect(builder.nChars).toBeGreaterThanOrEqual(10);

    const result = builder.ok('Operation completed');
    expect(result.output).toContain('Hello[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.output.endsWith('Output is truncated to fit in the message.')).toBe(true);
    expect(result.message).toContain('Operation completed.');
    expect(result.message).toContain('Output is truncated');
    expect(result.truncated).toBe(true);
  });

  it('truncates lines that exceed maxLineLength', () => {
    const builder = new ToolResultBuilder({ maxChars: 100, maxLineLength: 20 });

    expect(builder.write('This is a very long line that should be truncated\n')).toBe(20);

    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.message).toContain('Output is truncated');
  });

  it('respects both per-line and per-buffer limits at once', () => {
    const builder = new ToolResultBuilder({ maxChars: 40, maxLineLength: 20 });

    expect(builder.write('Line 1\n')).toBe(7);
    expect(builder.write('This is a very long line that exceeds limit\n')).toBe(20);
    expect(builder.write('This would exceed char limit')).toBe(14);
    expect(builder.write('ignored')).toBe(0);

    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.message).toContain('Output is truncated');
  });

  it('tracks nChars as the buffer grows', () => {
    const builder = new ToolResultBuilder({ maxChars: 20, maxLineLength: 30 });

    expect(builder.nChars).toBe(0);

    builder.write('Short\n');
    expect(builder.nChars).toBe(6);

    builder.write('1\n2\n');
    expect(builder.nChars).toBe(10);

    builder.write('More text that exceeds');
    expect(builder.nChars).toBeGreaterThanOrEqual(20);
  });

  it('marks truncation when non-empty text arrives after the buffer is full', () => {
    const builder = new ToolResultBuilder({ maxChars: 5 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(0);

    const result = builder.ok();
    expect(result.output).toContain('Hello[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.truncated).toBe(true);
  });

  it('marks truncation when a multi-line write leaves unprocessed lines', () => {
    const builder = new ToolResultBuilder({ maxChars: 6 });

    expect(builder.write('Hello\nworld')).toBe(6);

    const result = builder.ok();
    expect(result.output).toContain('Hello\n[...truncated]');
    expect(result.message).toContain('Output is truncated');
  });

  it('keeps unterminated trailing text in output', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    expect(builder.write('Line 1\nLine 2\nLine 3')).toBe(20);

    const result = builder.ok();
    expect(result.output).toBe('Line 1\nLine 2\nLine 3');
  });

  it('treats an empty write as a no-op', () => {
    const builder = new ToolResultBuilder({ maxChars: 50 });

    expect(builder.write('')).toBe(0);
    expect(builder.nChars).toBe(0);
  });

  it('returns the accumulated output with the supplied message and brief', () => {
    const builder = new ToolResultBuilder({ maxChars: 20 });

    builder.write('Some output');
    const result = builder.error('Something went wrong', { brief: 'Error occurred' });

    expect(result.output).toContain('Some output');
    expect(result.output).toContain('Something went wrong');
    expect(result.message).toBe('Something went wrong');
    expect(result.brief).toBe('Error occurred');
  });

  it('preserves an explicitly empty brief', () => {
    const builder = new ToolResultBuilder({ maxChars: 20 });

    const result = builder.ok('Done', { brief: '' });

    expect(result.brief).toBe('');
  });

  it('preserves the truncation hint and brief together on error', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('Very long output that exceeds limit');
    const result = builder.error('Command failed', { brief: 'Failed' });

    expect(result.output).toContain('[...truncated]');
    expect(result.message).toContain('Command failed');
    expect(result.message).toContain('Output is truncated');
    expect(result.brief).toBe('Failed');
  });

  it('returns executable output with critical messages included', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('Very long output that exceeds limit');
    const result = builder.ok('Operation completed');

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.message).toContain('Output is truncated');
  });

  it('keeps normal success messages out of non-empty output', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    builder.write('ok\n');
    const result = builder.ok('Command executed successfully.');

    expect(result.output).toBe('ok\n');
    expect(result.message).toBe('Command executed successfully.');
  });

  // ── Head-tail strategy tests (maxChars >= 2000) ─────────────────

  describe('head-tail truncation (maxChars >= 2000)', () => {
    // HEAD_MAX = floor(2000 * 0.55) = 1100
    // TAIL_MAX = floor(2000 * 0.40) = 800

    it('keeps all output when total fits within head', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      builder.write('small output');
      const result = builder.ok();
      expect(result.output).toBe('small output');
      expect(result.truncated).toBe(false);
    });

    it('preserves full content when head fills and tail continues without overflow', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      // 500-char lines with newlines (501 chars each). Two writes fill head
      // to 1002/1100; third write of 501 chars fills head to 1100 (99-char
      // per-line truncation adds `[...truncated]`). Fourth and fifth writes
      // go to tail. Total input ~2505 > 2000, so head-tail marker appears.
      const line = 'x'.repeat(500) + '\n';
      builder.write(line);
      builder.write(line);
      builder.write(line);   // head fills at 1100, 99-char overflow → per-line truncated
      builder.write(line);   // goes to tail
      builder.write(line);   // goes to tail, totalInput=2505 > 2000

      const result = builder.ok();
      expect(result.output).toContain('x'.repeat(500));
      // Tail content is present (somewhere after the marker)
      expect(result.output).toContain('[...truncated]');
      expect(result.truncated).toBe(true);
    });

    it('inserts a truncation marker with byte count between head and tail when total exceeds maxChars', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      // HEAD_MAX=1100, TAIL_MAX=800.
      // Write ~600-char lines to fill head, then ~500-char lines that go to
      // the tail ring buffer until total input exceeds maxChars.
      builder.write('A'.repeat(600) + '\n');   // 601 → head (601/1100)
      builder.write('A'.repeat(600) + '\n');   // 601 → head fills, per-line truncated
      builder.write('B'.repeat(500) + '\n');   // 501 → tail (501/800)
      builder.write('C'.repeat(500) + '\n');   // 501 → tail overflows, drops B → tail has C
      // totalInput=2204 > maxChars=2000 → data lost

      const result = builder.ok();
      expect(result.output).toContain('A'.repeat(600));    // head content
      expect(result.output).toContain('C'.repeat(500));    // tail content (last line that fits)
      expect(result.output).toMatch(/\[\.\.\.truncated\]\s+\d+(\.\d+)?\s*(B|KB|MB)/);
      expect(result.truncated).toBe(true);
    });

    it('shows the truncation message when data is lost', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      builder.write('A'.repeat(600) + '\n');
      builder.write('A'.repeat(600) + '\n');
      builder.write('B'.repeat(500) + '\n');
      builder.write('C'.repeat(500) + '\n');  // overflows

      const result = builder.ok('Done');
      expect(result.output).toContain('Output is truncated');
      expect(result.message).toContain('Done');
      expect(result.message).toContain('Output is truncated');
    });

    it('separates head and tail with marker when head ends without newline', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      // Write lines without trailing newline so head content is contiguous
      builder.write('A'.repeat(600));          // 600 → head (600/1100)
      builder.write('A'.repeat(600));          // 600 → head fills, line truncated
      builder.write('B'.repeat(500) + '\n');   // 501 → tail
      builder.write('C'.repeat(500) + '\n');   // 501 → tail overflows

      const result = builder.ok();
      // The head ends without \n, so assembleOutput inserts one before marker
      expect(result.output).toMatch(/\n\[\.\.\.truncated\]\s+\d+/);
      expect(result.output).toContain('C'.repeat(500)); // tail content present
    });

    it('correctly reports nChars as head + tail when using head-tail mode', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      expect(builder.nChars).toBe(0);

      builder.write('hello\n');
      expect(builder.nChars).toBeGreaterThan(0);
      expect(builder.nChars).toBe(6);
    });

    it('keeps the true end of the stream in the tail after large input', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      builder.write('H'.repeat(600) + '\n');
      builder.write('H'.repeat(600) + '\n'); // head fills
      for (let i = 0; i < 20; i += 1) {
        builder.write(`mid-${String(i)}-${'x'.repeat(490)}\n`);
      }
      builder.write('FATAL real tail error\n');

      const result = builder.ok();
      // The tail ring must keep rotating past maxChars — otherwise the
      // returned "tail" freezes mid-stream and the real final lines (where
      // errors live) are silently dropped.
      expect(result.output).toContain('FATAL real tail error');
      expect(result.truncated).toBe(true);
    });

    it('never reports more lost bytes than were written', () => {
      const builder = new ToolResultBuilder({ maxChars: 2000 });
      let totalWritten = 0;
      for (let i = 0; i < 10; i += 1) {
        const line = 'L'.repeat(500) + '\n';
        totalWritten += line.length;
        builder.write(line);
      }

      const result = builder.ok();
      const match = /\[\.{3}truncated\]\s+(\d+(?:\.\d+)?)\s*(B|KB|MB)/.exec(result.output);
      expect(match).not.toBeNull();
      const value = Number(match?.[1]);
      const unit = match?.[2];
      const lostBytes = unit === 'B' ? value : unit === 'KB' ? value * 1024 : value * 1024 * 1024;
      expect(lostBytes).toBeGreaterThan(0);
      expect(lostBytes).toBeLessThanOrEqual(totalWritten);
    });
  });
});
