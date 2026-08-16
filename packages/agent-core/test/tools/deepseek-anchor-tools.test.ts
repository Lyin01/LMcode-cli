import type { Jian, StatResult } from '@lmcode-cli/jian';
import { describe, expect, it, vi } from 'vitest';

import {
  DeepSeekStrReplaceEditorTool,
  type DeepSeekStrReplaceEditorInput,
} from '../../src/tools/builtin/deepseek-anchor/str-replace-editor';
import { EditTool } from '../../src/tools/builtin/file/edit';
import { WriteTool } from '../../src/tools/builtin/file/write';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeJian } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = {
  workspaceDir: '/workspace',
  additionalDirs: [],
};
const DIRECTORY_STAT = { stMode: 0o040755 } as StatResult;
const FILE_STAT = { stMode: 0o100644 } as StatResult;
const SYMLINK_STAT = { stMode: 0o120777 } as StatResult;

describe('DeepSeek anchor compatibility tools', () => {
  it('views, replaces, inserts, and creates files through the Minimal editor contract', async () => {
    const files = new Map<string, string>([
      ['/workspace/a.txt', 'one\ntwo\nthree\n'],
    ]);
    const jian = memoryJian(files);
    const tool = editor(jian);

    const viewed = await run(tool, {
      command: 'view',
      path: '/workspace/a.txt',
      view_range: [2, 3],
    });
    expect(viewed).toEqual({
      output:
        "Here's the content of /workspace/a.txt with line numbers (which has a total of 4 lines) with view_range=[2, 3]:\n" +
        '     2  two\n' +
        '     3  three\n',
    });

    const replaced = await run(tool, {
      command: 'str_replace',
      path: '/workspace/a.txt',
      old_str: 'two',
      new_str: 'TWO',
    });
    expect(replaced).toEqual({
      output: 'The file /workspace/a.txt has been edited successfully.',
    });

    const inserted = await run(tool, {
      command: 'insert',
      path: '/workspace/a.txt',
      insert_line: 2,
      new_str: 'between',
    });
    expect(inserted).toEqual({
      output: 'The file /workspace/a.txt has been edited successfully.',
    });
    expect(files.get('/workspace/a.txt')).toBe('one\nTWO\nbetween\nthree\n');

    const created = await run(tool, {
      command: 'create',
      path: '/workspace/new.txt',
      file_text: 'new file',
    });
    expect(created).toEqual({
      output: 'New file created successfully at: /workspace/new.txt',
    });
    expect(files.get('/workspace/new.txt')).toBe('new file');
  });

  it('rejects ambiguous replacements and create-overwrite attempts', async () => {
    const files = new Map<string, string>([
      ['/workspace/repeated.txt', 'same\nsame\n'],
    ]);
    const tool = editor(memoryJian(files));

    const ambiguous = await run(tool, {
      command: 'str_replace',
      path: '/workspace/repeated.txt',
      old_str: 'same',
      new_str: 'changed',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.output).toContain('not unique');
    expect(files.get('/workspace/repeated.txt')).toBe('same\nsame\n');

    const overwrite = await run(tool, {
      command: 'create',
      path: '/workspace/repeated.txt',
      file_text: 'overwrite',
    });
    expect(overwrite).toEqual({
      isError: true,
      output:
        'File already exists at: /workspace/repeated.txt. Cannot overwrite files using command `create`.',
    });
    expect(files.get('/workspace/repeated.txt')).toBe('same\nsame\n');
  });

  it('uses canonical permission rules for every editor command', async () => {
    const files = new Map<string, string>([['/workspace/a.txt', 'old']]);
    const tool = editor(memoryJian(files));

    const view = await tool.resolveExecution({ command: 'view', path: '/workspace/a.txt' });
    const create = await tool.resolveExecution({
      command: 'create',
      path: '/workspace/new.txt',
      file_text: 'new',
    });
    const replace = await tool.resolveExecution({
      command: 'str_replace',
      path: '/workspace/a.txt',
      old_str: 'old',
      new_str: 'new',
    });
    const insert = await tool.resolveExecution({
      command: 'insert',
      path: '/workspace/a.txt',
      insert_line: 0,
      new_str: 'first',
    });

    expect(view.isError === true ? undefined : view.approvalRule).toMatch(/^Read\(/);
    expect(create.isError === true ? undefined : create.approvalRule).toMatch(/^Write\(/);
    expect(replace.isError === true ? undefined : replace.approvalRule).toMatch(/^Edit\(/);
    expect(insert.isError === true ? undefined : insert.approvalRule).toMatch(/^Edit\(/);
  });

  it('blocks sensitive physical paths hidden behind symlinks', async () => {
    const jian = memoryJian(new Map(), {
      realpath: vi.fn(async (path: string) =>
        path === '/workspace/notes.txt' ? '/home/test/.ssh/id_rsa' : path,
      ),
    });
    const tool = editor(jian);

    await expect(
      tool.resolveExecution({ command: 'view', path: '/workspace/notes.txt' }),
    ).rejects.toMatchObject({ code: 'PATH_SENSITIVE' });
  });

  it('lists directory symlinks without traversing them', async () => {
    const visited: string[] = [];
    const jian = memoryJian(new Map(), {
      stat: vi.fn(async (path: string, options?: { followSymlinks?: boolean }) => {
        if (path === '/workspace') return DIRECTORY_STAT;
        if (path === '/workspace/external') {
          return options?.followSymlinks === false ? SYMLINK_STAT : DIRECTORY_STAT;
        }
        if (path === '/outside/secret.txt') return FILE_STAT;
        throw notFound(path);
      }),
      iterdir: async function* (path: string) {
        visited.push(path);
        if (path === '/workspace') yield '/workspace/external';
        if (path === '/outside') yield '/outside/secret.txt';
      },
    });

    const result = await run(editor(jian), { command: 'view', path: '/workspace' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('f\t/workspace/external');
    expect(result.output).not.toContain('secret.txt');
    expect(visited).toEqual(['/workspace']);
    expect(jian.stat).toHaveBeenCalledWith('/workspace/external', {
      followSymlinks: false,
    });
  });
});

function editor(jian: Jian): DeepSeekStrReplaceEditorTool {
  return new DeepSeekStrReplaceEditorTool(
    jian,
    workspace,
    new WriteTool(jian, workspace),
    new EditTool(jian, workspace),
  );
}

function run(tool: DeepSeekStrReplaceEditorTool, args: DeepSeekStrReplaceEditorInput) {
  return executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_editor',
    args,
    signal,
  });
}

function memoryJian(files: Map<string, string>, overrides: Partial<Jian> = {}): Jian {
  const stat = vi.fn(async (path: string): Promise<StatResult> => {
    if (path === '/workspace') return DIRECTORY_STAT;
    if (files.has(path)) return FILE_STAT;
    throw notFound(path);
  });
  return createFakeJian({
    stat,
    readText: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw notFound(path);
      return content;
    }),
    writeText: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return content.length;
    }),
    mkdir: vi.fn(async () => undefined),
    ...overrides,
  });
}

function notFound(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}
