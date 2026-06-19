import { describe, expect, it, vi } from 'vitest';

import {
  type MultiEditInput,
  MultiEditInputSchema,
  MultiEditTool,
} from '../../src/tools/builtin/file/multi-edit';
import { computeAnchor, toModelTextView } from '../../src/tools/builtin/file/line-endings';
import { createFakeJian, PERMISSIVE_WORKSPACE } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: MultiEditInput) {
  return { turnId: '0', toolCallId: 'call_multi_edit', args, signal };
}

describe('MultiEditTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new MultiEditTool(createFakeJian(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('MultiEdit');
    expect(tool.description).toContain('atomic');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array' },
      },
    });
    // At least one edit is required.
    expect(
      MultiEditInputSchema.safeParse({ path: '/tmp/a.txt', edits: [] }).success,
    ).toBe(false);
    expect(
      MultiEditInputSchema.safeParse({
        path: '/tmp/a.txt',
        edits: [{ old_string: 'a', new_string: 'b' }],
      }).success,
    ).toBe(true);
  });

  it('summarizes the batch on the file_io display for the approval panel', () => {
    const tool = new MultiEditTool(createFakeJian(), PERMISSIVE_WORKSPACE);
    const execution = tool.resolveExecution({
      path: '/tmp/foo.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'edit',
      path: '/tmp/foo.ts',
      detail: '2 edits',
      before: 'a\nb',
      after: 'A\nB',
    });
  });

  it('applies edits sequentially, each seeing the previous result', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('one two three'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        edits: [
          { old_string: 'one', new_string: '1' },
          { old_string: '1 two', new_string: 'X' }, // matches text produced by edit #1
        ],
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Applied 2 edits (2 replacements)');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'X three');
  });

  it('is atomic: a later failing edit leaves the file untouched', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('alpha beta'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        edits: [
          { old_string: 'alpha', new_string: 'A' }, // would succeed
          { old_string: 'zzz', new_string: 'Z' }, // not found → abort whole batch
        ],
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('edit #2');
    expect(result.output).toContain('not found');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects a non-unique edit without replace_all and writes nothing', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('x x'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/a.txt', edits: [{ old_string: 'x', new_string: 'y' }] }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not unique');
    expect(result.output).toContain('found 2 occurrences');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('honors replace_all within a single edit', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('a a a'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
      }),
    );

    expect(result.output).toContain('Applied 1 edit (3 replacements)');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'b b b');
  });

  it('rejects an edit whose old_string equals new_string', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('alpha'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/a.txt', edits: [{ old_string: 'alpha', new_string: 'alpha' }] }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('identical');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('verifies the anchor before applying any edit', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue('alpha beta'), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        edits: [{ old_string: 'beta', new_string: 'gamma' }],
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('anchor no longer matches');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('applies edits when the provided anchor matches', async () => {
    const content = 'alpha beta';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockResolvedValue(content), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        edits: [{ old_string: 'beta', new_string: 'gamma' }],
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'alpha gamma');
  });

  it('returns a Write-pointing error when the file does not exist', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new MultiEditTool(
      createFakeJian({ readText: vi.fn().mockRejectedValue(enoent), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/missing.txt', edits: [{ old_string: 'a', new_string: 'b' }] }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    expect(result.output).toContain('Write');
    expect(writeText).not.toHaveBeenCalled();
  });
});
