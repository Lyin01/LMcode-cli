/**
 * WriteTool — overwrite or append to a file.
 *
 * Creates the file if it does not exist, and creates any missing parent
 * directories so a write to a brand-new path succeeds in a single call.
 * Path access policy is resolved before any Jian I/O.
 */

import type { Jian } from '@lmcode-cli/jian';
import { dirname } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  pinPhysicalParentDirectory,
  resolveRealPathAccessPath,
  revalidateRealPathAccessPath,
} from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import WRITE_DESCRIPTION from './write.md';

/** Mask isolating the file-type bits of a stat mode. */
const S_IFMT = 0o170000;
/** File-type bits of a directory. */
const S_IFDIR = 0o040000;

export const WriteInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically — do not mkdir first.',
    ),
  content: z
    .string()
    .describe(
      'Raw full file content to write exactly as provided. This does not use the Read/Edit text view.',
    ),
  mode: z
    .enum(['overwrite', 'append'])
    .optional()
    .describe(
      'Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.',
    ),
});

export const WriteOutputSchema = z.object({
  /** Number of UTF-8 bytes written to disk by this call. */
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.Infer<typeof WriteInputSchema>;
export type WriteOutput = z.Infer<typeof WriteOutputSchema>;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async resolveExecution(args: WriteInput): Promise<ToolExecution> {
    const path = await resolveRealPathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${args.path}`,
      display: { kind: 'file_io', operation: 'write', path, content: args.content },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      execute: async () =>
        this.execution(
          args,
          await revalidateRealPathAccessPath(args.path, path, {
            jian: this.jian,
            workspace: this.workspace,
            operation: 'write',
          }),
        ),
    };
  }

  private async execution(args: WriteInput, safePath: string): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      await pinPhysicalParentDirectory(safePath, { jian: this.jian });
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        await this.jian.writeText(safePath, args.content, { mode: 'a' });
      } else {
        await this.jian.writeText(safePath, args.content);
      }
      // Report the number of UTF-8 bytes this call wrote to disk. The string
      // length would only equal the byte count for pure ASCII content, so it
      // is not used here.
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      return {
        output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
        return {
          isError: true,
          output: `Failed to write ${args.path}: parent directory does not exist.`,
        };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ensure the parent directory exists, creating it (recursively) when missing.
   *
   * A write to a not-yet-existing directory otherwise fails with a bare
   * `ENOENT`, forcing the model to `mkdir` and then re-emit the entire file
   * content on a second `Write` call — wasted latency and roughly doubled
   * output tokens for large files. Creating the directory here keeps it to a
   * single call. The path access policy has already authorized writing to this
   * location, so creating its parent is within the approved scope.
   *
   * Returns an error string only when the parent path exists but is not a
   * directory (unfixable), or when directory creation itself fails. Any other
   * `stat` failure (permissions, an environment without `stat`) is treated as
   * inconclusive: the check is skipped and the write proceeds, surfacing the
   * real I/O error if any.
   */
  private async ensureParentDirectory(safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat;
    try {
      stat = await this.jian.stat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await this.jian.mkdir(parent, { parents: true, existOk: true });
          return undefined;
        } catch (mkdirError) {
          return `Failed to create parent directory ${parent}: ${
            mkdirError instanceof Error ? mkdirError.message : String(mkdirError)
          }`;
        }
      }
      return undefined;
    }
    if ((stat.stMode & S_IFMT) !== S_IFDIR) {
      return `Parent path is not a directory: ${parent}.`;
    }
    return undefined;
  }
}
