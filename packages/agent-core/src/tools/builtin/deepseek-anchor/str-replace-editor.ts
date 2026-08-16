import { basename, join } from 'pathe';

import type { Jian, StatResult } from '@lmcode-cli/jian';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, RunnableToolExecution, ToolExecution } from '../../../loop/types';
import {
  pinPhysicalParentDirectory,
  resolveRealPathAccessPath,
  revalidateRealPathAccessPath,
} from '../../policies/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import type { EditTool } from '../file/edit';
import type { WriteTool } from '../file/write';
import DESCRIPTION from './str-replace-editor.md';
import type { DeepSeekEditorCommand } from './names';

const MAX_OUTPUT_CHARS = 16_000;
const RESPONSE_CLIPPED =
  '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export interface DeepSeekStrReplaceEditorInput {
  readonly command: DeepSeekEditorCommand;
  readonly path: string;
  readonly file_text?: string | undefined;
  readonly insert_line?: number | undefined;
  readonly new_str?: string | undefined;
  readonly old_str?: string | undefined;
  readonly view_range?: readonly number[] | undefined;
}

export class DeepSeekStrReplaceEditorTool
  implements BuiltinTool<DeepSeekStrReplaceEditorInput>
{
  readonly name = 'str_replace_editor' as const;
  readonly description = DESCRIPTION.trim();
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['view', 'create', 'str_replace', 'insert'],
        description:
          'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.',
      },
      path: {
        type: 'string',
        description: 'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.',
      },
      file_text: {
        type: 'string',
        description:
          'Required parameter of `create` command, with the content of the file to be created.',
      },
      insert_line: {
        type: 'integer',
        description:
          'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.',
      },
      new_str: {
        type: 'string',
        description:
          'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.',
      },
      old_str: {
        type: 'string',
        description:
          'Required parameter of `str_replace` command containing the string in `path` to replace.',
      },
      view_range: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.',
      },
    },
    required: ['command', 'path'],
  };

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly write: WriteTool,
    private readonly edit: EditTool,
  ) {}

  async resolveExecution(args: DeepSeekStrReplaceEditorInput): Promise<ToolExecution> {
    if (!isAbsoluteToolPath(args.path, this.jian.pathClass())) {
      return errorResult(
        `The path ${args.path} is not an absolute path. Provide an absolute path for str_replace_editor.`,
      );
    }

    switch (args.command) {
      case 'view':
        return this.resolveView(args);
      case 'create':
        return this.resolveCreate(args);
      case 'str_replace':
        return this.resolveReplace(args);
      case 'insert':
        return this.resolveInsert(args);
    }
  }

  private async resolveView(args: DeepSeekStrReplaceEditorInput): Promise<ToolExecution> {
    const path = await this.resolvePath(args.path, 'read');
    let stat: StatResult | undefined;
    try {
      stat = await this.jian.stat(path);
    } catch {
      stat = undefined;
    }
    const directory = stat !== undefined && isDirectory(stat);
    return {
      accesses: directory ? ToolAccesses.readTree(path) : ToolAccesses.readFile(path),
      description: `Viewing ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern('Read', path),
      matchesRule: this.pathRuleMatcher(path),
      execute: async () =>
        this.viewPath(
          args,
          await revalidateRealPathAccessPath(args.path, path, {
            jian: this.jian,
            workspace: this.workspace,
            operation: 'read',
          }),
        ),
    };
  }

  private async resolveCreate(args: DeepSeekStrReplaceEditorInput): Promise<ToolExecution> {
    if (args.file_text === undefined) {
      return errorResult('Parameter `file_text` is required for command: create');
    }
    const delegated = await this.write.resolveExecution({
      path: args.path,
      content: args.file_text,
      mode: 'overwrite',
    });
    if (delegated.isError === true) return delegated;
    const path = firstFileAccessPath(delegated) ?? args.path;
    return {
      ...delegated,
      description: `Creating ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'write',
        path,
        content: args.file_text,
      },
      execute: async (context) => {
        try {
          await this.jian.stat(path);
          return errorResult(
            `File already exists at: ${path}. Cannot overwrite files using command \`create\`.`,
          );
        } catch (error) {
          if (!isPathNotFoundError(error)) return errorResult(errorMessage(error));
        }
        const result = await delegated.execute(context);
        return result.isError === true
          ? result
          : { output: `New file created successfully at: ${path}` };
      },
    };
  }

  private async resolveReplace(args: DeepSeekStrReplaceEditorInput): Promise<ToolExecution> {
    if (args.old_str === undefined) {
      return errorResult('Parameter `old_str` is required for command: str_replace');
    }
    if (args.old_str.length === 0) {
      return errorResult('Parameter `old_str` is empty for command: str_replace');
    }
    const delegated = await this.edit.resolveExecution({
      path: args.path,
      old_string: args.old_str,
      new_string: args.new_str ?? '',
    });
    if (delegated.isError === true) return delegated;
    return {
      ...delegated,
      description: `Editing ${args.path}`,
      execute: async (context) => {
        const result = await delegated.execute(context);
        return result.isError === true
          ? result
          : { output: `The file ${args.path} has been edited successfully.` };
      },
    };
  }

  private async resolveInsert(args: DeepSeekStrReplaceEditorInput): Promise<ToolExecution> {
    if (args.insert_line === undefined) {
      return errorResult('Parameter `insert_line` is required for command: insert');
    }
    if (args.new_str === undefined) {
      return errorResult('Parameter `new_str` is required for command: insert');
    }
    const path = await this.resolvePath(args.path, 'write');
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        after: args.new_str,
        detail: `insert after line ${String(args.insert_line)}`,
      },
      approvalRule: literalRulePattern('Edit', path),
      matchesRule: this.pathRuleMatcher(path),
      execute: async () =>
        this.insertIntoPath(
          args,
          await revalidateRealPathAccessPath(args.path, path, {
            jian: this.jian,
            workspace: this.workspace,
            operation: 'write',
          }),
        ),
    };
  }

  private async viewPath(
    args: DeepSeekStrReplaceEditorInput,
    path: string,
  ): Promise<ExecutableToolResult> {
    try {
      const stat = await this.jian.stat(path);
      if (isDirectory(stat)) {
        if (args.view_range !== undefined) {
          return errorResult(
            'The `view_range` parameter is not allowed when `path` points to a directory.',
          );
        }
        return { output: await this.listDirectory(path) };
      }
      if (!isRegularFile(stat)) {
        return errorResult(`cannot view "${path}": not a regular file or directory`);
      }
      const content = await this.jian.readText(path, { errors: 'strict' });
      return { output: formatFileView(path, content, args.view_range) };
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  }

  private async listDirectory(path: string): Promise<string> {
    const rows: string[] = [`d\t${path}`];
    const visit = async (directory: string, depth: number): Promise<void> => {
      for await (const entryPath of this.jian.iterdir(directory)) {
        const name = basename(entryPath);
        if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
        let directoryEntry = false;
        try {
          // Do not recurse through directory symlinks. The requested root has
          // been physically authorized, but a child link may point elsewhere.
          directoryEntry = isDirectory(
            await this.jian.stat(entryPath, { followSymlinks: false }),
          );
        } catch {
          directoryEntry = false;
        }
        rows.push(`${directoryEntry ? 'd' : 'f'}\t${entryPath}`);
        if (directoryEntry && depth < 2) await visit(join(directory, name), depth + 1);
      }
    };
    await visit(path, 1);
    rows.sort((left, right) => codepointCompare(pathColumn(left), pathColumn(right)));
    const listing = truncateOutput(`${rows.join('\n')}\n`);
    return (
      `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n` +
      `${listing}\n`
    );
  }

  private async insertIntoPath(
    args: DeepSeekStrReplaceEditorInput,
    path: string,
  ): Promise<ExecutableToolResult> {
    try {
      const stat = await this.jian.stat(path);
      if (!isRegularFile(stat)) {
        return errorResult(`cannot insert into "${path}": not a regular file`);
      }
      const lines = (await this.jian.readText(path, { errors: 'strict' })).split('\n');
      const insertLine = args.insert_line!;
      if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
        return errorResult(
          `Invalid \`insert_line\` parameter: ${String(insertLine)}. It should be within the range of lines of the file: [0, ${String(lines.length)}]`,
        );
      }
      const next = [
        ...lines.slice(0, insertLine),
        ...args.new_str!.split('\n'),
        ...lines.slice(insertLine),
      ].join('\n');
      await pinPhysicalParentDirectory(path, { jian: this.jian });
      await this.jian.writeText(path, next);
      return { output: `The file ${path} has been edited successfully.` };
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  }

  private resolvePath(path: string, operation: 'read' | 'write'): Promise<string> {
    return resolveRealPathAccessPath(path, {
      jian: this.jian,
      workspace: this.workspace,
      operation,
    });
  }

  private pathRuleMatcher(path: string): (ruleArgs: string) => boolean {
    return (ruleArgs) =>
      matchesPathRuleSubject(ruleArgs, path, {
        cwd: this.workspace.workspaceDir,
        pathClass: this.jian.pathClass(),
        homeDir: this.jian.gethome(),
      });
  }
}

function formatFileView(
  path: string,
  content: string,
  viewRange: readonly number[] | undefined,
): string {
  const allLines = content.split('\n');
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${String(allLines.length)} lines)`;
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange;
    if (
      viewRange.length !== 2 ||
      requestedInitialLine === undefined ||
      requestedFinalLine === undefined ||
      !viewRange.every(Number.isInteger)
    ) {
      throw new Error('Invalid `view_range`. It should be a list of two integers.');
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${String(initialLine)}\` should be within the range of lines of the file: [1, ${String(allLines.length)}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${String(finalLine)}\` should be smaller than the number of lines in the file: \`${String(allLines.length)}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${String(finalLine)}\` should be larger or equal than its first \`${String(initialLine)}\``,
      );
    }
    lines =
      finalLine === -1
        ? allLines.slice(initialLine - 1)
        : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${String(initialLine)}, ${String(finalLine)}]`;
  }
  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, ' ')}  ${line}`)
    .join('\n');
  return truncateOutput(`${prompt}:\n${numbered}\n`);
}

function firstFileAccessPath(execution: RunnableToolExecution): string | undefined {
  const access = execution.accesses?.find((candidate) => candidate.kind === 'file');
  return access?.kind === 'file' ? access.path : undefined;
}

function isAbsoluteToolPath(path: string, pathClass: 'posix' | 'win32'): boolean {
  if (pathClass === 'posix') return path.startsWith('/');
  return (
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

function isDirectory(stat: StatResult): boolean {
  return (stat.stMode & S_IFMT) === S_IFDIR;
}

function isRegularFile(stat: StatResult): boolean {
  return (stat.stMode & S_IFMT) === S_IFREG;
}

function isPathNotFoundError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 2 || (error instanceof Error && error.name === 'JianFileNotFoundError');
}

function truncateOutput(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS
    ? content
    : content.slice(0, MAX_OUTPUT_CHARS) + RESPONSE_CLIPPED;
}

function pathColumn(row: string): string {
  const separator = row.indexOf('\t');
  return separator === -1 ? row : row.slice(separator + 1);
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(output: string): ExecutableToolResult & { readonly isError: true } {
  return { output, isError: true };
}
