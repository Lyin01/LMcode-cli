/**
 * WolfPackTool — batch parallel subagent execution.
 *
 * Spawns multiple subagents in parallel using a template + items pattern.
 * Each item gets its own subagent; results are batched together.
 * V1 uses Promise.allSettled — no concurrency control or rate-limit handling.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import WOLFPACK_DESCRIPTION from './wolfpack.md';

const MAX_ITEMS = 20;
export const WOLFPACK_MAX_ITEM_RESULT_CHARS = 8_000;
export const WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS = 32_000;
const MAX_ITEM_LABEL_CHARS = 200;

interface WolfPackAggregateItem {
  readonly item: string;
  readonly result: string;
  readonly success: boolean;
  readonly agentId?: string | undefined;
}

function truncateItemLabel(item: string): string {
  if (item.length <= MAX_ITEM_LABEL_CHARS) return item;
  const marker = '...[item label truncated]';
  return item.slice(0, MAX_ITEM_LABEL_CHARS - marker.length) + marker;
}

function truncateItemResult(result: string): string {
  if (result.length <= WOLFPACK_MAX_ITEM_RESULT_CHARS) return result;
  const marker = `\n[WolfPack item output truncated: ${String(result.length)} chars exceeds ${String(
    WOLFPACK_MAX_ITEM_RESULT_CHARS,
  )}-char limit]`;
  return result.slice(0, WOLFPACK_MAX_ITEM_RESULT_CHARS - marker.length) + marker;
}

function capAggregateOutput(header: string, details: string): string {
  const output = `${header}\n\n## Results\n${details}`;
  if (output.length <= WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS) return output;

  const marker = `\n\n[WolfPack aggregate output truncated: ${String(
    output.length,
  )} chars exceeds ${String(
    WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS,
  )}-char limit. The agent manifest above is complete.]`;
  const detailPrefix = `${header}\n\n## Results\n`;
  const detailBudget = Math.max(
    0,
    WOLFPACK_MAX_AGGREGATE_OUTPUT_CHARS - detailPrefix.length - marker.length,
  );
  return detailPrefix + details.slice(0, detailBudget) + marker;
}

export const WolfPackToolInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Short task description (3-5 words, e.g., "Security review all files")'),
  subagent_type: z
    .string()
    .default('coder')
    .describe('Subagent type for all spawned agents (e.g., coder, explore, verify)'),
  prompt_template: z
    .string()
    .min(1)
    .describe('Prompt template with {{item}} placeholder. Each item is substituted in.'),
  items: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_ITEMS)
    .describe('Array of items to process. Each item gets its own subagent.'),
});

export type WolfPackToolInput = z.infer<typeof WolfPackToolInputSchema>;

export class WolfPackTool implements BuiltinTool<WolfPackToolInput> {
  readonly name: string = 'WolfPack';
  readonly description: string = WOLFPACK_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WolfPackToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly isEnabled: () => boolean,
    _options?: { log?: Logger },
  ) {}

  resolveExecution(args: WolfPackToolInput): ToolExecution {
    return {
      description: `WolfPack: ${args.description} (${args.items.length} agents)`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'generic',
        summary: `WolfPack: ${args.description}`,
        detail: { itemCount: args.items.length, subagent_type: args.subagent_type },
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WolfPackToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    ctx.signal.throwIfAborted();

    if (!this.isEnabled()) {
      return {
        output: 'WolfPack 模式未开启。请输入 /wolfpack 打开后再试。',
        isError: true,
      };
    }

    if (args.items.length > MAX_ITEMS) {
      return {
        output: `WolfPack max ${MAX_ITEMS} items. Got ${args.items.length}.`,
        isError: true,
      };
    }

    const profileName = args.subagent_type ?? 'coder';
    const template = args.prompt_template;

    // Spawn all subagents in parallel
    const handlePromises = args.items.map(
      async (item): Promise<{ item: string; handle: SubagentHandle }> => {
        ctx.signal.throwIfAborted();
        const prompt = template.replace(/\{\{item\}\}/g, item);
        const handle = await this.subagentHost.spawn(profileName, {
          parentToolCallId: ctx.toolCallId,
          prompt,
          description: `${args.description}: ${item}`,
          runInBackground: false,
          signal: ctx.signal,
        });
        return { item, handle };
      },
    );

    const handleResults = await Promise.allSettled(handlePromises);

    // Wait for all completions
    const completionPromises = handleResults.map(
      async (settled, index): Promise<{ item: string; result: string; success: boolean; agentId?: string }> => {
        if (settled.status === 'rejected') {
          const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          return { item: args.items[index]!, result: `Spawn failed: ${msg}`, success: false };
        }

        const { item, handle } = settled.value;
        try {
          const completion = await handle.completion;
          return {
            item,
            result: completion.result,
            success: true,
            agentId: handle.agentId,
          };
        } catch (error) {
          let message: string;
          if (isAbortError(error)) {
            message = 'The subagent was stopped before it finished.';
          } else {
            message = error instanceof Error ? error.message : String(error);
          }
          return { item, result: message, success: false, agentId: handle.agentId };
        }
      },
    );

    const completions = await Promise.allSettled(completionPromises);

    const aggregateItems = completions.map((settled, index): WolfPackAggregateItem => {
      if (settled.status === 'fulfilled') return settled.value;
      const handleResult = handleResults[index];
      const agentId =
        handleResult?.status === 'fulfilled' ? handleResult.value.handle.agentId : undefined;
      const message =
        settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      return {
        item: args.items[index]!,
        result: `Completion failed: ${message}`,
        success: false,
        agentId,
      };
    });

    const successCount = aggregateItems.filter((item) => item.success).length;
    const failureCount = aggregateItems.length - successCount;
    const summary = `Success: ${successCount}, Failed: ${failureCount}, Total: ${aggregateItems.length}`;
    const manifestLines = ['## Agent manifest'];
    const detailSections: string[] = [];

    for (const [index, aggregateItem] of aggregateItems.entries()) {
      const status = aggregateItem.success ? 'OK' : 'FAILED';
      const agentId = aggregateItem.agentId ?? 'not-started';
      const itemLabel = truncateItemLabel(aggregateItem.item);
      manifestLines.push(
        `${String(index + 1)}. status=${status} agent_id=${agentId} item=${JSON.stringify(itemLabel)}`,
      );
      detailSections.push(
        [
          `### ${itemLabel} (${status})`,
          `agent_id: ${agentId}`,
          '',
          truncateItemResult(aggregateItem.result),
        ].join('\n'),
      );
    }

    const output = capAggregateOutput(
      [summary, '', ...manifestLines].join('\n'),
      detailSections.join('\n\n'),
    );

    if (failureCount > 0 && successCount === 0) {
      return {
        output,
        isError: true,
      };
    }

    return { output };
  }
}
