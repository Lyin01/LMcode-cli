import type { Jian } from '@lmcode-cli/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { literalRulePattern } from '../../support/rule-match';
import { toInputJsonSchema } from '../../support/input-schema';
import type { WorkspaceConfig } from '../../support/workspace';
import { MAX_LINES, ReadTool } from './read';
import readGroupDescriptionTemplate from './read-group.md';

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

export const MAX_READ_GROUP_FILES = 10;

const NonEmptyStringArraySchema = z.array(z.string().min(1)).min(1).max(MAX_READ_GROUP_FILES);

// Mirror the Read tool's offset contract (positive from line 1, or a
// [-MAX_LINES, -1] tail offset) -- ReadGroup constructs ReadTool directly and
// would otherwise accept line_offset 0 or < -MAX_LINES, which Read rejects.
const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadGroupInputSchema = z.object({
  paths: NonEmptyStringArraySchema.describe(
    `Array of file paths to read in parallel (1-${String(MAX_READ_GROUP_FILES)} files).`,
  ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe('Starting line number applied to every file.'),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum lines per file.'),
});

export type ReadGroupInput = z.Infer<typeof ReadGroupInputSchema>;

const READ_GROUP_DESCRIPTION = renderPrompt(readGroupDescriptionTemplate, {});

type ReadGroupItem =
  | { path: string; exec: RunnableToolExecution }
  | { path: string; error: string };

export class ReadGroupTool implements BuiltinTool<ReadGroupInput> {
  readonly name = 'ReadGroup' as const;
  readonly description = READ_GROUP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadGroupInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async resolveExecution(args: ReadGroupInput): Promise<ToolExecution> {
    const paths = args.paths.slice(0, MAX_READ_GROUP_FILES);
    const readTool = new ReadTool(this.jian, this.workspace);
    const executions = await Promise.all(
      paths.map(async (path): Promise<ReadGroupItem> => {
        try {
          const exec = await readTool.resolveExecution({
            path,
            line_offset: args.line_offset,
            n_lines: args.n_lines,
          });
          if ('isError' in exec && exec.isError === true) {
            return { path, error: toolOutputText(exec.output) };
          }
          return { path, exec };
        } catch (error) {
          return { path, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    const accesses = executions
      .filter((e): e is { path: string; exec: RunnableToolExecution } => 'exec' in e)
      .flatMap((e) => e.exec.accesses ?? ToolAccesses.none());
    const sortedPaths = [...paths].sort();
    const approvalRule = literalRulePattern(this.name, sortedPaths.join('\n'));
    const deniedCount = executions.filter((e) => 'error' in e).length;

    return {
      accesses,
      description:
        deniedCount > 0
          ? `Reading ${String(paths.length)} files (${String(deniedCount)} denied)`
          : `Reading ${String(paths.length)} files`,
      display: { kind: 'file_io', operation: 'read', path: paths.join(', ') },
      approvalRule,
      matchesRule: (ruleArgs) => ruleArgs === approvalRule,
      execute: (ctx: ExecutableToolContext) => this.execution(executions, ctx),
    };
  }

  private async execution(
    executions: ReadGroupItem[],
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const results = await Promise.all(
      executions.map(async (item) => {
        if ('error' in item) {
          return {
            path: item.path,
            result: { isError: true, output: item.error } satisfies ExecutableToolResult,
          };
        }
        try {
          const result = await item.exec.execute(ctx);
          return { path: item.path, result };
        } catch (error) {
          return {
            path: item.path,
            result: {
              isError: true,
              output: error instanceof Error ? error.message : String(error),
            } satisfies ExecutableToolResult,
          };
        }
      }),
    );

    const parts: string[] = [];
    let hasError = false;
    for (const { path, result } of results) {
      if (parts.length > 0) parts.push('');
      parts.push(`--- ${path} ---`);
      if (result.isError === true) {
        hasError = true;
        parts.push(`[ERROR] ${toolOutputText(result.output)}`);
      } else {
        parts.push(toolOutputText(result.output));
      }
    }

    return {
      isError: hasError,
      output: parts.join('\n'),
    };
  }
}
