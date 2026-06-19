import { describe, expect, it } from 'vitest';

import type { ModelPricingConfig } from '../../src/config';
import { UsageRecorder } from '../../src/agent/usage';

/**
 * Minimal Agent stub: UsageRecorder only touches `records.logRecord`,
 * `emitStatusUpdated`, and `lmcodeConfig.models` (for pricing lookup).
 */
function stubAgent(
  pricing?: Record<string, ModelPricingConfig>,
): ConstructorParameters<typeof UsageRecorder>[0] {
  const models =
    pricing === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(pricing).map(([model, p]) => [model, { pricing: p }]),
        );
  return {
    records: { logRecord: () => {} },
    emitStatusUpdated: () => {},
    lmcodeConfig: models === undefined ? undefined : { models },
  } as unknown as ConstructorParameters<typeof UsageRecorder>[0];
}

describe('Agent usage', () => {
  it('accumulates usage by model', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    usage.record('model-b', {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    });

    expect(usage.data()).toEqual({
      byModel: {
        'model-a': {
          inputOther: 11,
          output: 22,
          inputCacheRead: 33,
          inputCacheCreation: 44,
        },
        'model-b': {
          inputOther: 100,
          output: 200,
          inputCacheRead: 300,
          inputCacheCreation: 400,
        },
      },
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage separately from session totals', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.beginTurn();
    usage.record(
      'model-a',
      {
        inputOther: 10,
        output: 20,
        inputCacheRead: 30,
        inputCacheCreation: 40,
      },
      'turn',
    );
    usage.record(
      'model-b',
      {
        inputOther: 100,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
      'turn',
    );

    expect(usage.data()).toMatchObject({
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: {
        inputOther: 110,
        output: 220,
        inputCacheRead: 330,
        inputCacheCreation: 440,
      },
    });

    usage.endTurn();

    expect(usage.data().currentTurn).toBeUndefined();
  });

  it('returns immutable status snapshots', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    const snapshot = usage.data();

    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });

    expect(snapshot).toEqual({
      byModel: {
        'model-a': {
          inputOther: 1,
          output: 2,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        },
      },
      total: {
        inputOther: 1,
        output: 2,
        inputCacheRead: 3,
        inputCacheCreation: 4,
      },
      currentTurn: undefined,
    });
  });
});

describe('Agent usage stats', () => {
  it('returns a zeroed summary with no activity', () => {
    const usage = new UsageRecorder();
    const stats = usage.stats();

    expect(stats).toEqual({
      total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: undefined,
      costByModel: undefined,
      llmSteps: 0,
      toolCalls: 0,
      toolCallsByName: undefined,
      retries: 0,
      compactions: 0,
    });
  });

  it('aggregates tokens across models and counts activity', () => {
    const usage = new UsageRecorder();
    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 5,
      inputCacheCreation: 1,
    });
    usage.record('model-b', {
      inputOther: 100,
      output: 200,
      inputCacheRead: 50,
      inputCacheCreation: 10,
    });
    usage.recordLlmStep();
    usage.recordLlmStep();
    usage.recordToolCall('Read');
    usage.recordToolCall('Read');
    usage.recordToolCall('Bash');
    usage.recordRetry();
    usage.recordCompaction();

    const stats = usage.stats();
    expect(stats.total).toEqual({
      inputOther: 110,
      output: 220,
      inputCacheRead: 55,
      inputCacheCreation: 11,
    });
    expect(stats.inputTokens).toBe(110 + 55 + 11);
    expect(stats.outputTokens).toBe(220);
    expect(stats.cacheReadTokens).toBe(55);
    expect(stats.cacheWriteTokens).toBe(11);
    expect(stats.totalTokens).toBe(110 + 55 + 11 + 220);
    expect(stats.llmSteps).toBe(2);
    expect(stats.toolCalls).toBe(3);
    expect(stats.toolCallsByName).toEqual({ Read: 2, Bash: 1 });
    expect(stats.retries).toBe(1);
    expect(stats.compactions).toBe(1);
    // No pricing configured -> no cost.
    expect(stats.estimatedCostUsd).toBeUndefined();
    expect(stats.costByModel).toBeUndefined();
  });

  it('estimates cost only for priced models', () => {
    const usage = new UsageRecorder(
      stubAgent({ 'priced-model': { input: 3, output: 15 } }),
    );
    usage.record('priced-model', {
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    // unpriced-model has usage but no pricing -> excluded from cost.
    usage.record('unpriced-model', {
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const stats = usage.stats();
    // priced: 1M*3 + 1M*15 = 18 (per million)
    expect(stats.estimatedCostUsd).toBeCloseTo(18, 10);
    expect(stats.costByModel).toEqual({ 'priced-model': 18 });
  });

  it('sums cost across multiple priced models', () => {
    const usage = new UsageRecorder(
      stubAgent({
        'model-a': { input: 1, output: 2 },
        'model-b': { input: 10, output: 20 },
      }),
    );
    usage.record('model-a', {
      inputOther: 1_000_000,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    usage.record('model-b', {
      inputOther: 0,
      output: 1_000_000,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const stats = usage.stats();
    // model-a: 1M input * 1 = 1 ; model-b: 1M output * 20 = 20
    expect(stats.costByModel).toEqual({ 'model-a': 1, 'model-b': 20 });
    expect(stats.estimatedCostUsd).toBeCloseTo(21, 10);
  });
});
