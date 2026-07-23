import type { SessionStats, UsageStatus } from '#/rpc';
import {
  addUsage,
  emptyUsage,
  grandTotal,
  inputTotal,
  usageCost,
  type ModelPricing,
  type TokenUsage,
} from '@lmcode-cli/ltod';

import type { Agent } from '..';
import { normalizeTokenUsage } from './normalize';

export * from './normalize';

export type UsageRecordScope = 'session' | 'turn';

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  // Session-level observability counters. Kept here (rather than re-derived
  // from raw events) so the harness records each signal exactly once at the
  // point it already flows through the turn loop.
  private llmSteps = 0;
  private toolCalls = 0;
  private readonly toolCallsByName: Record<string, number> = {};
  private retries = 0;
  private compactions = 0;

  constructor(protected readonly agent?: Agent) {}

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    const normalizedUsage = normalizeTokenUsage(usage);
    this.agent?.records.logRecord({
      type: 'usage.record',
      model,
      usage: normalizedUsage,
      usageScope: scope,
    });
    const current = this.byModel[model];
    this.byModel[model] =
      current === undefined
        ? copyUsage(normalizedUsage)
        : normalizeTokenUsage(addUsage(current, normalizedUsage));

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined
          ? copyUsage(normalizedUsage)
          : normalizeTokenUsage(addUsage(this.currentTurn, normalizedUsage));

      // Log cache hit ratio for prefix-cache diagnostics.
      // `inputCacheRead` tokens cost ~2% of regular input tokens on DeepSeek.
      const cacheHit = normalizedUsage.inputCacheRead;
      const cacheMiss = normalizedUsage.inputOther + normalizedUsage.inputCacheCreation;
      const total = cacheHit + cacheMiss;
      if (total > 0) {
        const ratio = ((cacheHit / total) * 100).toFixed(1);
        this.agent?.log.info('llm cache', {
          turnStep: this.llmSteps,
          cacheHitTokens: cacheHit,
          cacheMissTokens: cacheMiss,
          cacheHitRatio: `${ratio}%`,
        });
      }
    }
    this.agent?.emitStatusUpdated();
  }

  /** Count one completed LLM step (one model generation in the turn loop). */
  recordLlmStep(): void {
    this.llmSteps += 1;
  }

  /** Count one tool execution, optionally bucketed by tool name. */
  recordToolCall(name?: string): void {
    this.toolCalls += 1;
    if (name !== undefined && name.length > 0) {
      this.toolCallsByName[name] = (this.toolCallsByName[name] ?? 0) + 1;
    }
  }

  /** Count one LLM step retry attempt. */
  recordRetry(): void {
    this.retries += 1;
  }

  /** Count one completed context compaction. */
  recordCompaction(): void {
    this.compactions += 1;
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined
    ) {
      return undefined;
    }
    return status;
  }

  /**
   * Structured per-session summary for observability. Reuses the aggregated
   * `byModel` usage (and the shared `grandTotal`/`inputTotal` helpers) rather
   * than re-summing raw events, and prices each model against its configured
   * rates. `estimatedCostUsd` is `undefined` when no priced model has accrued
   * usage; per-model costs are only present for models that have pricing.
   */
  stats(): SessionStats {
    const total = totalUsage(this.byModel) ?? emptyUsage();
    const costByModel: Record<string, number> = {};
    let estimatedCostUsd: number | undefined;
    for (const [model, usage] of Object.entries(this.byModel)) {
      const cost = usageCost(usage, this.pricingFor(model));
      if (cost === undefined) continue;
      costByModel[model] = cost;
      estimatedCostUsd = (estimatedCostUsd ?? 0) + cost;
    }
    return {
      total: copyUsage(total),
      inputTokens: inputTotal(total),
      outputTokens: total.output,
      cacheReadTokens: total.inputCacheRead,
      cacheWriteTokens: total.inputCacheCreation,
      totalTokens: grandTotal(total),
      estimatedCostUsd,
      costByModel: Object.keys(costByModel).length > 0 ? costByModel : undefined,
      llmSteps: this.llmSteps,
      toolCalls: this.toolCalls,
      toolCallsByName:
        Object.keys(this.toolCallsByName).length > 0 ? { ...this.toolCallsByName } : undefined,
      retries: this.retries,
      compactions: this.compactions,
    };
  }

  private pricingFor(model: string): ModelPricing | undefined {
    return this.agent?.lmcodeConfig?.models?.[model]?.pricing;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total =
      total === undefined
        ? copyUsage(usage)
        : normalizeTokenUsage(addUsage(total, usage));
  }
  return total;
}
