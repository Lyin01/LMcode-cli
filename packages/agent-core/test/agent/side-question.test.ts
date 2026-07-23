import type { GenerateResult } from '@lmcode-cli/ltod';
import { describe, expect, it } from 'vitest';

import type { AgentOptions } from '../../src/agent';
import type { LmcodeConfig } from '../../src/config';
import { testAgent } from './harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const UTILITY_MODEL = 'utility-alias';
const UTILITY_PROVIDER_MODEL = 'utility-upstream';

const config: LmcodeConfig = {
  providers: {
    utility: {
      type: 'lmcode',
      apiKey: 'utility-key',
      baseUrl: 'https://utility.example/v1',
    },
  },
  utilityModel: UTILITY_MODEL,
  models: {
    [UTILITY_MODEL]: {
      provider: 'utility',
      model: UTILITY_PROVIDER_MODEL,
      maxContextSize: 100_000,
    },
  },
};

describe('Agent side question', () => {
  it('attributes utility-model usage to the session without charging the active goal', async () => {
    let providerModel: string | undefined;
    const generate: GenerateFn = async (provider) => {
      providerModel = provider.modelName;
      return textResult('The concise answer.');
    };
    const ctx = testAgent({ generate, initialConfig: config });
    ctx.configure();
    await ctx.agent.goal.createGoal({ objective: 'Keep working on the main task' });

    await expect(ctx.agent.sideQuestion('Quick question?')).resolves.toBe('The concise answer.');

    expect(providerModel).toBe(UTILITY_PROVIDER_MODEL);
    expect(ctx.agent.usage.data()).toMatchObject({
      byModel: {
        [UTILITY_MODEL]: {
          inputOther: 11,
          output: 6,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
      total: {
        inputOther: 11,
        output: 6,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    });
    expect(ctx.agent.usage.data().currentTurn).toBeUndefined();
    expect(ctx.agent.goal.getGoal().goal?.tokensUsed).toBe(0);
  });
});

function textResult(text: string): GenerateResult {
  return {
    id: 'side-question-result',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 11,
      output: 6,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}
