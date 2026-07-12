import { describe, expect, it } from 'vitest';

import { MAX_TOOL_RESULT_TOKENS } from '../../../src/agent/context/tool-output-limits';
import { ToolAccesses } from '../../../src/loop/tool-access';
import type { ExecutableToolResult } from '../../../src/loop/types';
import { estimateTokens } from '../../../src/utils/tokens';
import { ToolCallDeduplicator, __testing } from '../../../src/agent/turn/tool-dedup';

const { REMINDER_TEXT_1, makeReminderText2 } = __testing;

function okResult(text: string): ExecutableToolResult {
  return { output: text };
}

function errResult(text: string): ExecutableToolResult {
  return { output: text, isError: true };
}

function readResult(start: number, count: number, totalLines: number): ExecutableToolResult {
  return okResult(
    `<system>${String(count)} ${count === 1 ? 'line' : 'lines'} read from file starting from line ${String(start)}. ` +
      `Total lines in file: ${String(totalLines)}.</system>`,
  );
}

function emptyReadResult(totalLines: number): ExecutableToolResult {
  return okResult(
    `<system>No lines read from file. Total lines in file: ${String(totalLines)}. End of file reached.</system>`,
  );
}

function mutationArgs(tool: string, path: string, revision: number): Record<string, unknown> {
  if (tool === 'Write') return { path, content: `content-${String(revision)}` };
  const edit = {
    old_string: `old-${String(revision)}`,
    new_string: `new-${String(revision)}`,
  };
  return tool === 'MultiEdit' ? { path, edits: [edit] } : { path, ...edit };
}

/**
 * Drives one full lifecycle for a single (original) tool call:
 * beginStep is the caller's responsibility — this only handles checkSameStep
 * + finalizeResult for the original (first-occurrence) call.
 */
async function runOriginal(
  deduper: ToolCallDeduplicator,
  callId: string,
  tool: string,
  args: unknown,
  result: ExecutableToolResult,
): Promise<ExecutableToolResult> {
  const cached = deduper.checkSameStep(callId, tool, args);
  expect(cached).toBeNull();
  return deduper.finalizeResult(callId, tool, args, result);
}

describe('ToolCallDeduplicator', () => {
  describe('same-step dedup', () => {
    it('returns a placeholder synchronously and resolves to the real result on finalize', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const original = await runOriginal(dedup, 'c1', 'Read', { path: '/a' }, okResult('FILE_A'));
      const cached = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      // Same-step dup gets a synthetic placeholder (non-error, empty string).
      expect(cached).not.toBeNull();
      expect(cached!.isError).toBeUndefined();
      // Finalize substitutes the original's real result.
      const finalDup = await dedup.finalizeResult('c2', 'Read', { path: '/a' }, cached!);
      expect(finalDup).toEqual(original);
    });

    it('propagates error results to same-step dups', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      await runOriginal(dedup, 'c1', 'Bash', { cmd: 'x' }, errResult('boom'));
      const cached = dedup.checkSameStep('c2', 'Bash', { cmd: 'x' });
      expect(cached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('c2', 'Bash', { cmd: 'x' }, cached!);
      expect(finalDup).toEqual(errResult('boom'));
    });

    it('finalizes original before dup (provider order)', async () => {
      // The loop guarantees finalize runs in provider order, so by the time a
      // dup's finalize runs, the original's deferred is already resolved.
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const origCached = dedup.checkSameStep('c1', 'Read', { path: '/a' });
      expect(origCached).toBeNull();
      const dupCached = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      expect(dupCached).not.toBeNull();
      // Finalize in provider order: c1 first, then c2.
      const origFinal = await dedup.finalizeResult('c1', 'Read', { path: '/a' }, okResult('A'));
      const dupFinal = await dedup.finalizeResult('c2', 'Read', { path: '/a' }, dupCached!);
      expect(origFinal).toEqual(okResult('A'));
      expect(dupFinal).toEqual(okResult('A'));
    });

    it('deduplicates canonical Read aliases with equivalent default ranges', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      expect(dedup.checkSameStep('c1', 'Read', { path: 'src/./a.ts' })).toBeNull();
      const duplicate = dedup.checkSameStep('c2', 'Read', {
        path: '/workspace/src/a.ts',
        line_offset: 1,
        n_lines: 1000,
      });
      expect(duplicate).toEqual({ output: '' });

      const original = await dedup.finalizeResult(
        'c1',
        'Read',
        { path: 'src/./a.ts' },
        okResult('same read'),
      );
      expect(
        await dedup.finalizeResult(
          'c2',
          'Read',
          { path: '/workspace/src/a.ts', line_offset: 1, n_lines: 1000 },
          duplicate!,
        ),
      ).toEqual(original);
    });
  });

  describe('cross-step streak', () => {
    it('does not inject reminder below 3 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(typeof last!.output).toBe('string');
      expect(last!.output as string).not.toContain('<system-reminder>');
    });

    it('injects reminder1 at exactly 3 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 3; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeating the exact same tool call');
      expect(last!.output as string).not.toContain('repeated_times');
    });

    it('does not inject reminder at 4 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 4; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).not.toContain('<system-reminder>');
    });

    it('injects reminder2 at exactly 5 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 5; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeated_times: 5');
      expect(last!.output as string).toContain('tool: Read');
      expect(last!.output as string).toContain('arguments:');
    });

    it('does not inject reminder at 6 or 7 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 7; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).not.toContain('<system-reminder>');
    });

    it('injects reminder2 at exactly 8 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 8; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeated_times: 8');
      expect(last!.output as string).toContain('tool: Read');
    });

    it('resets streak when a different call is interleaved', async () => {
      const dedup = new ToolCallDeduplicator();
      // 2× Read({p:1}) — should NOT trigger yet
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `a${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      // 1× Read({p:2}) interrupts the streak
      dedup.beginStep();
      await runOriginal(dedup, 'b1', 'Read', { p: 2 }, okResult('R'));
      dedup.endStep();
      // Back to Read({p:1}); streak restarts → 1 occurrence, no reminder
      dedup.beginStep();
      const last = await runOriginal(dedup, 'c1', 'Read', { p: 1 }, okResult('R'));
      dedup.endStep();
      expect(last.output as string).not.toContain('<system-reminder>');
    });

    it('same-step dups inherit reminder1 when streak triggers on original', async () => {
      const dedup = new ToolCallDeduplicator();
      // Build streak up to 2 across previous steps.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      // Next step: same call appears twice. First is the original (triggers reminder1 at streak=3),
      // second is a same-step dup that should inherit it.
      dedup.beginStep();
      const original = await runOriginal(
        dedup,
        'orig',
        'Read',
        { p: 1 },
        okResult('R'),
      );
      const dupCached = dedup.checkSameStep('dup', 'Read', { p: 1 });
      expect(dupCached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('dup', 'Read', { p: 1 }, dupCached!);
      dedup.endStep();

      expect(original.output as string).toContain('<system-reminder>');
      expect(original.output as string).toContain('repeating the exact same tool call');
      expect(finalDup.output as string).toContain('<system-reminder>');
      expect(finalDup.output as string).toContain('repeating the exact same tool call');
    });

    it('same-step spam alone does not trigger reminder', async () => {
      const dedup = new ToolCallDeduplicator();
      // 8 occurrences of the same call within a single step, but no prior
      // streak — the trigger is about sustained behaviour across steps, not
      // intra-step spam. Same-step dedup already short-circuits execution.
      dedup.beginStep();
      const cached = dedup.checkSameStep('orig', 'Read', { p: 1 });
      expect(cached).toBeNull();
      for (let i = 0; i < 7; i += 1) {
        dedup.checkSameStep(`dup${String(i)}`, 'Read', { p: 1 });
      }
      const final = await dedup.finalizeResult('orig', 'Read', { p: 1 }, okResult('R'));
      expect(final.output as string).not.toContain('<system-reminder>');
    });
  });

  describe('reminder injection into ContentPart[] outputs', () => {
    it('appends reminder1 to a trailing text part at streak 3', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'text', text: 'hello' }],
      };
      // Build streak up to 2 prior steps then this one (streak=3).
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text: string }>;
      expect(arr).toHaveLength(1);
      expect(arr[0]!.type).toBe('text');
      expect(arr[0]!.text).toBe('hello' + REMINDER_TEXT_1);
    });

    it('appends reminder2 to a trailing text part at streak 5', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'text', text: 'hello' }],
      };
      // Build streak up to 4 prior steps then this one (streak=5).
      for (let i = 0; i < 4; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', { a: 1 }, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', { a: 1 }, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text: string }>;
      expect(arr).toHaveLength(1);
      expect(arr[0]!.type).toBe('text');
      expect(arr[0]!.text).toBe('hello' + makeReminderText2('X', 5, { a: 1 }));
    });

    it('pushes a new text part when trailing part is non-text', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'image_url', imageUrl: { url: 'data:foo' } }],
      };
      // Build streak to 3.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text?: string }>;
      expect(arr).toHaveLength(2);
      expect(arr[0]!.type).toBe('image_url');
      expect(arr[1]!.type).toBe('text');
      expect(arr[1]!.text).toBe(REMINDER_TEXT_1);
    });

    it('preserves isError flag when injecting reminder', async () => {
      const dedup = new ToolCallDeduplicator();
      // Build streak to 3.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, errResult('boom'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, errResult('boom'));
      dedup.endStep();
      expect(final.isError).toBe(true);
      expect(final.output as string).toContain('<system-reminder>');
    });
  });

  describe('key canonicalization', () => {
    it('treats argument objects with different key order as the same call', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      await runOriginal(dedup, 'c1', 'Read', { a: 1, b: 2 }, okResult('SAME'));
      const cached = dedup.checkSameStep('c2', 'Read', { b: 2, a: 1 });
      expect(cached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('c2', 'Read', { b: 2, a: 1 }, cached!);
      expect(finalDup).toEqual(okResult('SAME'));
    });
  });

  describe('arg rewrite between checkSameStep and finalize', () => {
    it('resolves the dup deferred even when the original call args are rewritten before finalize', async () => {
      // Models the loop contract: prepareToolExecution may return
      // {updatedArgs}, in which case finalizeToolResult sees the rewritten
      // args. The dedup key registered at checkSameStep time uses the
      // LLM-issued args; the deferred must be resolved under that same key.
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const c1 = dedup.checkSameStep('c1', 'Read', { path: '/a' });
      expect(c1).toBeNull();
      const c2 = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      expect(c2).not.toBeNull();

      // Original finalize is called with REWRITTEN args (simulates a hook
      // returning updatedArgs).
      const finalC1 = await dedup.finalizeResult(
        'c1',
        'Read',
        { path: '/REWRITTEN' },
        okResult('A'),
      );
      // Dup's finalize must not hang — it should resolve via the deferred
      // registered under the original-args key.
      const finalC2 = await Promise.race([
        dedup.finalizeResult('c2', 'Read', { path: '/a' }, c2!),
        new Promise<ExecutableToolResult>((_, reject) => {
          setTimeout(() => {
            reject(new Error('dup finalize hung — deferred was never resolved'));
          }, 500);
        }),
      ]);
      expect(finalC1).toEqual(okResult('A'));
      expect(finalC2).toEqual(okResult('A'));
    });
  });

  describe('successful Read coverage', () => {
    it('blocks a canonical subrange that was already returned', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-1',
        'Read',
        { path: 'src/a.ts', line_offset: 1, n_lines: 100 },
        readResult(1, 100, 200),
      );
      dedup.endStep();

      dedup.beginStep();
      const blocked = dedup.checkSameStep('read-2', 'Read', {
        path: '/workspace/src/./a.ts',
        line_offset: 20,
        n_lines: 10,
      });
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('lines 20-29');
      expect(blocked!.output).toContain('already read successfully');
    });

    it('treats a default read of a short file as complete through EOF', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-1',
        'Read',
        { path: 'src/a.ts' },
        readResult(1, 20, 20),
      );
      dedup.endStep();

      dedup.beginStep();
      const blocked = dedup.checkSameStep('read-2', 'Read', {
        path: '/workspace/src/a.ts',
      });
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('lines 1-20');
    });

    it('uses Windows path casing and separators for one coverage identity', async () => {
      const dedup = new ToolCallDeduplicator('C:/repo', 'win32');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-1',
        'Read',
        { path: 'C:\\Repo\\SRC\\a.ts', line_offset: 1, n_lines: 10 },
        readResult(1, 10, 20),
      );
      dedup.endStep();

      dedup.beginStep();
      expect(
        dedup.checkSameStep('read-2', 'Read', {
          path: 'c:/repo/src/./A.ts',
          line_offset: 1,
          n_lines: 10,
        }),
      ).toMatchObject({ isError: true });
    });

    it('allows an uncovered overlap, then merges adjacent successful ranges', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-1',
        'Read',
        { path: 'a.ts', line_offset: 1, n_lines: 100 },
        readResult(1, 100, 200),
      );
      dedup.endStep();

      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-2',
        'Read',
        { path: 'a.ts', line_offset: 90, n_lines: 20 },
        readResult(90, 20, 200),
      );
      dedup.endStep();

      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-3',
        'Read',
        { path: 'a.ts', line_offset: 110, n_lines: 10 },
        readResult(110, 10, 200),
      );
      dedup.endStep();

      dedup.beginStep();
      const blocked = dedup.checkSameStep('read-4', 'Read', {
        path: 'a.ts',
        line_offset: 95,
        n_lines: 25,
      });
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('lines 95-119');
    });

    it('projects negative tail offsets using the observed total line count', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'a.ts', line_offset: -20, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-1', 'Read', args, readResult(81, 10, 100));
      dedup.endStep();

      dedup.beginStep();
      const blocked = dedup.checkSameStep('read-2', 'Read', args);
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('lines 81-90');
    });

    it('blocks a repeated request that is known to start beyond EOF', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'a.ts', line_offset: 100, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-1', 'Read', args, emptyReadResult(12));
      dedup.endStep();

      dedup.beginStep();
      const blocked = dedup.checkSameStep('read-2', 'Read', args);
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('beyond the known end of file');
    });

    it('does not build coverage from failed reads or status-like file content', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'failed',
        'Read',
        { path: 'failed.ts', line_offset: 1, n_lines: 10 },
        errResult('read failed'),
      );
      await runOriginal(
        dedup,
        'spoofed',
        'Read',
        { path: 'spoofed.ts', line_offset: 1, n_lines: 1 },
        okResult(
          '1\t500 lines read from file starting from line 1.\n' +
            '<system>1 line read from file starting from line 1. Total lines in file: 500.</system>',
        ),
      );
      dedup.endStep();

      dedup.beginStep();
      expect(
        dedup.checkSameStep('failed-again', 'Read', {
          path: 'failed.ts',
          line_offset: 1,
          n_lines: 10,
        }),
      ).toBeNull();
      expect(
        dedup.checkSameStep('spoofed-same', 'Read', {
          path: 'spoofed.ts',
          line_offset: 1,
          n_lines: 1,
        }),
      ).toMatchObject({ isError: true });
      expect(
        dedup.checkSameStep('spoofed-next', 'Read', {
          path: 'spoofed.ts',
          line_offset: 2,
          n_lines: 1,
        }),
      ).toBeNull();
    });

    it('allows rereading when the earlier output was too large to remain model-visible', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'large.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(
        dedup,
        'large-read',
        'Read',
        args,
        okResult(
          `${'x'.repeat(40_000)}\n` +
            '<system>10 lines read from file starting from line 1. Total lines in file: 20.</system>',
        ),
      );
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('large-read-again', 'Read', args)).toBeNull();
    });

    it('uses the reminder-appended size when deciding whether Read output stays visible', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'near-limit.ts', line_offset: 1, n_lines: 10 };
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `failed-${String(i)}`, 'Read', args, errResult('failed'));
        dedup.endStep();
      }

      const status =
        '\n<system>10 lines read from file starting from line 1. Total lines in file: 20.</system>';
      const body = 'x'.repeat(MAX_TOOL_RESULT_TOKENS * 4 - status.length - 4);
      const executionResult = okResult(body + status);
      expect(estimateTokens(executionResult.output as string)).toBeLessThanOrEqual(
        MAX_TOOL_RESULT_TOKENS,
      );

      dedup.beginStep();
      const persisted = await runOriginal(dedup, 'near-limit', 'Read', args, executionResult);
      expect(estimateTokens(persisted.output as string)).toBeGreaterThan(
        MAX_TOOL_RESULT_TOKENS,
      );
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('near-limit-again', 'Read', args)).toBeNull();
    });

    it('allows rereading after model-visible context may have been compacted', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'a.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-1', 'Read', args, readResult(1, 10, 20));
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('blocked', 'Read', args)).toMatchObject({ isError: true });
      dedup.clearReadCoverage();
      expect(dedup.checkSameStep('allowed', 'Read', args)).toBeNull();
    });

    it('keeps cross-step coverage disabled after asynchronous side effects start', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'a.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-1', 'Read', args, readResult(1, 10, 20));
      dedup.endStep();
      dedup.disableReadCoverage();

      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(
          dedup,
          `read-after-background-${String(i)}`,
          'Read',
          args,
          readResult(1, 10, 20),
        );
        dedup.endStep();
      }
    });
  });

  describe('write invalidation', () => {
    it.each(['Write', 'Edit', 'MultiEdit'])('%s success invalidates all file coverage', async (tool) => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const readArgs = { path: 'src/a.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-a', 'Read', readArgs, readResult(1, 10, 20));
      await runOriginal(
        dedup,
        'read-b',
        'Read',
        { path: 'src/b.ts', line_offset: 1, n_lines: 10 },
        readResult(1, 10, 20),
      );
      dedup.endStep();

      dedup.beginStep();
      const mutationArgs = { path: '/workspace/src/./a.ts', revision: tool };
      expect(dedup.checkSameStep('mutation', tool, mutationArgs)).toBeNull();
      dedup.observeAuthorizedExecution(
        'mutation',
        ToolAccesses.writeFile('/workspace/src/a.ts'),
      );
      await dedup.finalizeResult('mutation', tool, mutationArgs, okResult('changed'));
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('read-a-again', 'Read', readArgs)).toBeNull();
      expect(
        dedup.checkSameStep('read-b-again', 'Read', {
          path: 'src/b.ts',
          line_offset: 1,
          n_lines: 10,
        }),
      ).toBeNull();
    });

    it('does not reuse a pre-write Read deferred later in the same batch', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const readArgs = { path: 'a.ts', line_offset: 1, n_lines: 10 };
      const editArgs = { path: 'a.ts', old_string: 'a', new_string: 'b' };
      dedup.beginStep();
      expect(dedup.checkSameStep('read-before', 'Read', readArgs)).toBeNull();
      expect(dedup.checkSameStep('edit', 'Edit', editArgs)).toBeNull();
      dedup.observeAuthorizedExecution('edit', ToolAccesses.readWriteFile('/workspace/a.ts'));

      // A placeholder here would replay the pre-edit result.
      expect(dedup.checkSameStep('read-after', 'Read', readArgs)).toBeNull();
    });

    it('allows a covered Read after an earlier writer in the same batch', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const readArgs = { path: 'a.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read-old', 'Read', readArgs, readResult(1, 10, 20));
      dedup.endStep();

      dedup.beginStep();
      const editArgs = { path: 'a.ts', old_string: 'a', new_string: 'b' };
      expect(dedup.checkSameStep('edit', 'Edit', editArgs)).toBeNull();
      dedup.observeAuthorizedExecution('edit', ToolAccesses.readWriteFile('/workspace/a.ts'));
      expect(dedup.checkSameStep('read-new', 'Read', readArgs)).toBeNull();
    });

    it('invalidates coverage when an authorized writer reports failure', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const readArgs = { path: 'a.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read', 'Read', readArgs, readResult(1, 10, 20));
      dedup.endStep();

      dedup.beginStep();
      const editArgs = { path: 'a.ts', old_string: 'a', new_string: 'b' };
      expect(dedup.checkSameStep('edit', 'Edit', editArgs)).toBeNull();
      dedup.observeAuthorizedExecution('edit', ToolAccesses.readWriteFile('/workspace/a.ts'));
      await dedup.finalizeResult('edit', 'Edit', editArgs, errResult('not found'));
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('read-again', 'Read', readArgs)).toBeNull();
    });

    it('failed unknown-access execution clears all file coverage', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      await runOriginal(
        dedup,
        'read-a',
        'Read',
        { path: 'a.ts', line_offset: 1, n_lines: 10 },
        readResult(1, 10, 20),
      );
      await runOriginal(
        dedup,
        'read-b',
        'Read',
        { path: 'b.ts', line_offset: 1, n_lines: 10 },
        readResult(1, 10, 20),
      );
      dedup.endStep();

      dedup.beginStep();
      const bashArgs = { command: 'generate files' };
      expect(dedup.checkSameStep('bash', 'Bash', bashArgs)).toBeNull();
      dedup.observeAuthorizedExecution('bash', undefined);
      await dedup.finalizeResult('bash', 'Bash', bashArgs, errResult('exited 1'));
      dedup.endStep();

      dedup.beginStep();
      expect(
        dedup.checkSameStep('read-a-again', 'Read', {
          path: 'a.ts',
          line_offset: 1,
          n_lines: 10,
        }),
      ).toBeNull();
      expect(
        dedup.checkSameStep('read-b-again', 'Read', {
          path: 'b.ts',
          line_offset: 1,
          n_lines: 10,
        }),
      ).toBeNull();
    });

    it('invalidates coverage through a different lexical path to cover file aliases', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const readArgs = { path: 'link.ts', line_offset: 1, n_lines: 10 };
      dedup.beginStep();
      await runOriginal(dedup, 'read', 'Read', readArgs, readResult(1, 10, 20));
      dedup.endStep();

      dedup.beginStep();
      const editArgs = { path: 'target.ts', old_string: 'a', new_string: 'b' };
      expect(dedup.checkSameStep('edit', 'Edit', editArgs)).toBeNull();
      dedup.observeAuthorizedExecution('edit', ToolAccesses.readWriteFile('/workspace/target.ts'));
      await dedup.finalizeResult('edit', 'Edit', editArgs, okResult('changed'));
      dedup.endStep();

      dedup.beginStep();
      expect(dedup.checkSameStep('read-again', 'Read', readArgs)).toBeNull();
    });
  });

  describe('mutation Storm Breaker', () => {
    it('blocks the third identical mutation attempt', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const args = { path: 'a.ts', content: 'same' };
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `write-${String(i)}`, 'Write', args, errResult('failed'));
        dedup.endStep();
      }

      dedup.beginStep();
      const blocked = dedup.checkSameStep('write-3', 'Write', args);
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('identical arguments 3 times');
    });

    it('blocks the sixth mixed mutation attempt against one canonical file', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      const tools = ['Write', 'Edit', 'MultiEdit', 'Write', 'Edit'];
      const paths = ['src/a.ts', '/workspace/src/a.ts', 'src/./a.ts'];
      for (const [index, tool] of tools.entries()) {
        dedup.beginStep();
        await runOriginal(
          dedup,
          `mutation-${String(index)}`,
          tool,
          mutationArgs(tool, paths[index % paths.length]!, index),
          okResult('changed'),
        );
        dedup.endStep();
      }

      dedup.beginStep();
      const blocked = dedup.checkSameStep(
        'mutation-6',
        'MultiEdit',
        mutationArgs('MultiEdit', '/workspace/src/../src/a.ts', 6),
      );
      expect(blocked).toMatchObject({ isError: true });
      expect(blocked!.output).toContain('5 mutation attempts');
    });

    it('does not combine mutation counts from different files', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      for (let i = 0; i < 5; i += 1) {
        dedup.beginStep();
        await runOriginal(
          dedup,
          `mutation-${String(i)}`,
          'Edit',
          mutationArgs('Edit', 'a.ts', i),
          okResult('changed'),
        );
        dedup.endStep();
      }

      dedup.beginStep();
      expect(
        dedup.checkSameStep('other-file', 'Edit', mutationArgs('Edit', 'b.ts', 6)),
      ).toBeNull();
    });

    it('applies the eight-attempt window within one large provider batch', async () => {
      const dedup = new ToolCallDeduplicator('/workspace', 'posix');
      dedup.beginStep();
      for (let i = 0; i < 5; i += 1) {
        await runOriginal(
          dedup,
          `old-a-${String(i)}`,
          'Edit',
          mutationArgs('Edit', 'a.ts', i),
          okResult('changed'),
        );
      }
      for (let i = 0; i < 3; i += 1) {
        await runOriginal(
          dedup,
          `other-${String(i)}`,
          'Edit',
          mutationArgs('Edit', `other-${String(i)}.ts`, i),
          okResult('changed'),
        );
      }

      expect(
        dedup.checkSameStep(
          'still-blocked-a',
          'MultiEdit',
          mutationArgs('MultiEdit', 'a.ts', 98),
        ),
      ).toMatchObject({ isError: true });

      await runOriginal(
        dedup,
        'other-3',
        'Edit',
        mutationArgs('Edit', 'other-3.ts', 3),
        okResult('changed'),
      );

      expect(
        dedup.checkSameStep(
          'fresh-a',
          'MultiEdit',
          mutationArgs('MultiEdit', 'a.ts', 99),
        ),
      ).toBeNull();
    });
  });

  describe('beginStep cleanup', () => {
    it('resolves leaked deferreds from a prior aborted step with an error result', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      // Register an original but never finalize it (simulates abort mid-step).
      const orig = dedup.checkSameStep('leaked', 'Read', { p: 1 });
      expect(orig).toBeNull();
      // Register a dup that captures the leaked deferred.
      const dupCached = dedup.checkSameStep('dup', 'Read', { p: 1 });
      expect(dupCached).not.toBeNull();

      // Next step begins — the leaked deferred should resolve so an awaiter
      // doesn't hang. (In production the dup's finalize would have already
      // happened before beginStep, but defensively resolving leaked deferreds
      // protects against any ordering bug.)
      dedup.beginStep();
      // Finalize the dup that captured the leaked deferred. Since we cleared
      // syntheticCallIds in beginStep, this is no longer tracked — it just
      // returns the placeholder it was passed. The leaked deferred has been
      // resolved with an error result but nothing is awaiting it now.
      const finalDup = await dedup.finalizeResult('dup', 'Read', { p: 1 }, dupCached!);
      expect(finalDup).toEqual(dupCached);
    });
  });
});
