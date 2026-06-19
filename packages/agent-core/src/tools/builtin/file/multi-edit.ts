/**
 * MultiEditTool — apply several exact string replacements to one file in a
 * single atomic call.
 *
 * Edits apply sequentially in array order; each one operates on the result of
 * the previous, so a later edit can match text an earlier edit produced. The
 * whole batch is validated and applied in memory first — if ANY edit fails
 * (old_string missing, or not unique without replace_all), nothing is written
 * and the file is left untouched. This collapses what would otherwise be N
 * separate Edit round-trips (N model turns) into one. Path access policy is
 * resolved before any Jian I/O.
 */

import type { Jian } from '@lmcode-cli/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { materializeModelText, toModelTextView, computeAnchor } from './line-endings';
import MULTI_EDIT_DESCRIPTION from './multi-edit.md';

// `old_string` must be non-empty for the same reason as Edit: an empty search
// string has no well-defined occurrence to replace.
const SingleEditSchema = z.object({
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
    ),
  new_string: z
    .string()
    .describe('Replacement text in the same Read output view.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of this edit\'s old_string should be replaced.'),
});

export const MultiEditInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
    ),
  edits: z
    .array(SingleEditSchema)
    .min(1, 'Provide at least one edit.')
    .describe(
      'Edits applied sequentially in order; each one sees the result of the previous one. The whole batch is atomic — if any edit fails to apply, none are written.',
    ),
  anchor: z
    .string()
    .optional()
    .describe(
      'Content anchor from the most recent Read of this file. When provided, MultiEdit verifies the file content has not changed before applying any edit.',
    ),
});

export type MultiEditInput = z.Infer<typeof MultiEditInputSchema>;

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export class MultiEditTool implements BuiltinTool<MultiEditInput> {
  readonly name = 'MultiEdit' as const;
  readonly description = MULTI_EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MultiEditInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: MultiEditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'write',
    });
    const editCount = args.edits.length;
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path} (${String(editCount)} edits)`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        detail: `${String(editCount)} edit${editCount === 1 ? '' : 's'}`,
        before: args.edits.map((edit) => edit.old_string).join('\n'),
        after: args.edits.map((edit) => edit.new_string).join('\n'),
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: MultiEditInput, safePath: string): Promise<ExecutableToolResult> {
    try {
      const raw = await this.jian.readText(safePath);
      const modelView = toModelTextView(raw);
      let content = modelView.text;

      if (args.anchor !== undefined) {
        const currentAnchor = computeAnchor(content);
        if (currentAnchor !== args.anchor) {
          return {
            isError: true,
            output: `File has changed since last read. The anchor no longer matches (expected ${args.anchor}, got ${currentAnchor}). Please re-read the file and retry.`,
          };
        }
      }

      // Apply every edit in memory first; the batch is atomic, so a failure
      // anywhere aborts before a single byte is written.
      let totalReplacements = 0;
      for (let i = 0; i < args.edits.length; i += 1) {
        const edit = args.edits[i]!;
        const label = `edit #${String(i + 1)}`;

        if (edit.old_string === edit.new_string) {
          return {
            isError: true,
            output: `${label}: old_string and new_string are identical; nothing to change. No edits were applied.`,
          };
        }

        const replaceAll = edit.replace_all ?? false;
        const parts = content.split(edit.old_string);
        const count = parts.length - 1;

        if (count === 0) {
          return {
            isError: true,
            output:
              `${label}: old_string not found in ${args.path}. No edits were applied (the batch is atomic). ` +
              'Re-read the file and verify the exact text and whitespace; remember each edit operates on the result of the previous one.',
          };
        }
        if (!replaceAll && count > 1) {
          return {
            isError: true,
            output:
              `${label}: old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
              'Add more surrounding context to target one occurrence, or set replace_all=true. No edits were applied (the batch is atomic).',
          };
        }

        content = replaceAll
          ? parts.join(edit.new_string)
          : replaceOnceLiteral(content, edit.old_string, edit.new_string);
        totalReplacements += replaceAll ? count : 1;
      }

      await this.jian.writeText(safePath, materializeModelText(content, modelView.lineEndingStyle));

      const editCount = args.edits.length;
      return {
        output: `Applied ${String(editCount)} edit${editCount === 1 ? '' : 's'} (${String(
          totalReplacements,
        )} replacement${totalReplacements === 1 ? '' : 's'}) to ${args.path}`,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      if (code === 'ENOENT') {
        return {
          isError: true,
          output: `${args.path} does not exist. MultiEdit only edits existing files; use Write to create a new file.`,
        };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
