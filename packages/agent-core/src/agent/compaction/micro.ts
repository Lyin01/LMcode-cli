import type { ContentPart } from '@lmcode-cli/liumir';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { estimateTokens, estimateTokensForMessage } from '../../utils/tokens';

/**
 * Default absolute cap on micro-compaction's trigger, in estimated tokens.
 *
 * A ratio-only trigger is late on large-window models: with a 1M window the
 * 0.5 ratio trims nothing until half a million tokens, while gateway
 * first-token latency is already multi-second around 200k. The cap only ever
 * lowers the trigger, so windows small enough for the ratio to fire earlier
 * are unaffected. `0` disables the cap.
 */
export const DEFAULT_MICRO_COMPACTION_WORKING_SET_TOKENS = 200_000;

export interface MicroCompactionConfig {
  /** Number of most recent messages to always keep untouched. */
  keepRecentMessages: number;
  /** Only truncate tool results with at least this many tokens. */
  minContentTokens: number;
  /** Minimum context usage ratio (0-1) before micro-compaction triggers. */
  minContextUsageRatio: number;
  /** Absolute working-set cap (estimated tokens); `0` disables the cap. */
  workingSetTokens: number;
  /** Placeholder text for truncated tool results. */
  truncatedMarker: string;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  minContextUsageRatio: 0.5,
  workingSetTokens: DEFAULT_MICRO_COMPACTION_WORKING_SET_TOKENS,
  truncatedMarker: '[Old tool result content cleared]',
};

/**
 * Walk the message list and find Read tool calls whose file paths were
 * superseded by a later Read of the same path. Returns a map from the
 * superseded tool call's ID to the file path (for the marker text).
 *
 * Only considers tool results before the cutoff line — newer reads are
 * protected and their results are kept verbatim.
 */
function findSupersededPaths(
  messages: readonly ContextMessage[],
  cutoff: number,
): Map<string, string> {
  const superseded = new Map<string, string>();
  const readCalls = new Map<string, { id: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;

    if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        if (
          tc.name === 'Read' &&
          tc.id !== undefined &&
          tc.arguments !== undefined
        ) {
          const filePath = (
            typeof tc.arguments === 'object' && tc.arguments !== null
              ? (tc.arguments as Record<string, unknown>)['file_path']
              : undefined
          ) as string | undefined;
          if (filePath !== undefined) {
            // O(1) lookup: any earlier read of the same path is superseded by
            // this one when it sits before the cutoff line.
            const prior = readCalls.get(filePath);
            if (prior !== undefined && prior.index < cutoff) {
              superseded.set(prior.id, filePath);
            }
            readCalls.set(filePath, { id: tc.id, index: i });
          }
        }
      }
    }
  }

  return superseded;
}

/**
 * Lightweight compaction that truncates old tool results without an LLM call.
 *
 * When the context window is filling up (>= 50% by default), old tool result
 * messages are replaced with a short placeholder. This frees up tokens for the
 * model without the cost and latency of a full compaction.
 *
 * Triggered automatically during context construction via {@link compact}.
 */
export class MicroCompaction {
  private cutoff = 0;
  private _revision = 0;
  readonly config: MicroCompactionConfig;

  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.config = {
      ...merged,
      // A forwarded `undefined` override must not erase the default: callers
      // pass optional file-config values straight through.
      workingSetTokens: merged.workingSetTokens ?? DEFAULT_MICRO_COMPACTION_WORKING_SET_TOKENS,
    };
  }

  /** Reset the internal cutoff line (e.g. after a full compaction). */
  reset(maxCutoff = 0): void {
    const nextCutoff = Math.min(this.cutoff, maxCutoff);
    if (nextCutoff === this.cutoff) return;
    this.cutoff = nextCutoff;
    this._revision += 1;
  }

  get revision(): number {
    return this._revision;
  }

  /** Advance the cutoff line and log the change. */
  private apply(cutoff: number): void {
    const changed = cutoff !== this.cutoff;
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    } as Record<string, unknown> as never);
    this.cutoff = cutoff;
    if (changed) this._revision += 1;
  }

  /** Check whether micro-compaction is warranted and advance the cutoff. */
  detect(): void {
    const config = this.config;
    const { history } = this.agent.context;
    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    const contextTokens = this.agent.context.tokenCountWithPending;
    // Trigger at the smaller of the window-ratio threshold and the absolute
    // working-set cap. An unknown window keeps the historic behavior
    // (the ratio trigger fires at zero tokens).
    const ratioTriggerTokens =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? maxContextTokens * config.minContextUsageRatio
        : 0;
    const triggerTokens =
      config.workingSetTokens > 0
        ? Math.min(ratioTriggerTokens, config.workingSetTokens)
        : ratioTriggerTokens;
    if (contextTokens < triggerTokens) return;

    const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
    this.apply(nextCutoff);
  }

  /**
   * Apply micro-compaction to a message list: replace old tool results
   * before the cutoff line with truncated markers. Read results for files
   * that were re-read later get a supersede marker so the model knows
   * the old content is stale.
   */
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    const config = this.config;
    const superseded = findSupersededPaths(messages, this.cutoff);
    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      if (
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForMessage(msg) >= config.minContentTokens
      ) {
        const marker =
          msg.toolCallId !== undefined && superseded.has(msg.toolCallId)
            ? `[Superseded by a newer read of ${superseded.get(msg.toolCallId)}]`
            : config.truncatedMarker;
        result.push({
          ...msg,
          content: [{ type: 'text', text: marker } as ContentPart],
        } as ContextMessage);
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }

  /**
   * Estimate how many tokens micro-compaction would save at the current
   * cutoff. Used by the unified compaction pipeline so Full can decide
   * whether it still needs to run after Micro has been applied.
   */
  estimateSavings(messages: readonly ContextMessage[]): number {
    const { beforeTokens, afterTokens } = this.measureEffect(messages, this.cutoff);
    return beforeTokens - afterTokens;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ): { truncatedToolResultCount: number; beforeTokens: number; afterTokens: number } {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let beforeTokens = 0;
    let afterTokens = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForMessage(message);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokens(this.config.truncatedMarker);
      truncatedToolResultCount += 1;
      beforeTokens += contentTokens;
      afterTokens += markerTokenCount;
    }
    return { truncatedToolResultCount, beforeTokens, afterTokens };
  }
}
