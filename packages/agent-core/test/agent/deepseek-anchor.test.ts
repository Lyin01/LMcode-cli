import type { ProviderConfig } from '@lmcode-cli/ltod';
import { DreamTracker } from '@lmcode/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import type { LmcodeConfig } from '../../src/config';
import type { GenerateCall } from './harness';
import {
  createCommandJian,
  DEFAULT_TEST_SYSTEM_PROMPT,
  testAgent,
  type TestAgentContext,
} from './harness';

const DEEPSEEK_PRO = 'opencode-go/deepseek-v4-pro';
const DEEPSEEK_FLASH = 'opencode-go-rsp/deepseek-v4-flash';
const REQUIRED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep'] as const;
const BOOTSTRAP_TOOLS = ['Bash', 'Edit', 'Read', 'Write'] as const;

describe('DeepSeek V4 request anchoring', () => {
  beforeEach(() => {
    vi.spyOn(DreamTracker.prototype, 'shouldSuggest').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([DEEPSEEK_PRO, DEEPSEEK_FLASH])(
    'sends canonical bootstrap tools and full context on the first %s request',
    async (model) => {
      const ctx = configuredDeepSeekAgent(model);
      ctx.agent.context.appendSystemReminder('automatic context must remain visible', {
        kind: 'injection',
        variant: 'test',
      });

      await runTextTurn(ctx, 'inspect the project', 'done');

      const request = ctx.llmCalls[0]!;
      expect(request.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
      expect(request.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP_TOOLS);
      expect(requestText(request)).toContain('inspect the project');
      expect(requestText(request)).toContain('automatic context must remain visible');
    },
  );

  it('promotes a text-only first reply to the canonical full LMcode catalog', async () => {
    const ctx = configuredDeepSeekAgent(DEEPSEEK_PRO);
    ctx.agent.context.appendSystemReminder('deferred automatic context', {
      kind: 'injection',
      variant: 'test',
    });

    await runTextTurn(ctx, 'first prompt', 'first answer');
    await runTextTurn(ctx, 'second prompt', 'second answer');

    const [first, second] = ctx.llmCalls;
    expect(first?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(second?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(new Set(second?.tools.map((tool) => tool.name))).toEqual(new Set(REQUIRED_TOOLS));
    expect(requestText(first!)).toContain('deferred automatic context');
    expect(requestText(second!)).toContain('deferred automatic context');
  });

  it('promotes request #2 in the same turn and accounts for canonical tools', async () => {
    const ctx = configuredDeepSeekAgent(DEEPSEEK_PRO, {
      jian: createCommandJian('anchored'),
    });
    await ctx.rpc.setPermission({ mode: 'auto' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_anchor_bash',
      name: 'Bash',
      arguments: '{"command":"printf anchored"}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
    await ctx.untilTurnEnd();

    const [first, second] = ctx.llmCalls;
    expect(first?.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP_TOOLS);
    expect(new Set(second?.tools.map((tool) => tool.name))).toEqual(new Set(REQUIRED_TOOLS));
    expect(requestText(first!)).toContain('Auto permission mode is active');
    expect(requestText(second!)).toContain('Auto permission mode is active');
    expect(ctx.agent.usage.stats().toolCallsByName).toEqual({ Bash: 1 });
    const toolCall = ctx.agent.context.history
      .flatMap((message) => message.toolCalls)
      .find((call) => call.id === 'call_anchor_bash');
    expect(toolCall?.name).toBe('Bash');
  });

  it('keeps the alias in the transcript while requesting permission as canonical Bash', async () => {
    const ctx = configuredDeepSeekAgent(DEEPSEEK_PRO, {
      jian: createCommandJian('approved'),
    });
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_permission_bash',
      name: 'Bash',
      arguments: '{"command":"printf approved"}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run with approval' }] });
    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'requestApproval',
        args: expect.objectContaining({
          toolCallId: 'call_permission_bash',
          toolName: 'Bash',
        }),
      }),
    );
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    const toolCall = ctx.agent.context.history
      .flatMap((message) => message.toolCalls)
      .find((call) => call.id === 'call_permission_bash');
    expect(toolCall?.name).toBe('Bash');
  });

  it('preserves promotion when the completed session is resumed', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = configuredDeepSeekAgent(DEEPSEEK_PRO, { persistence });
    await runTextTurn(original, 'first prompt', 'first answer');

    const resumed = testAgent({
      persistence,
      initialConfig: deepSeekConfig(DEEPSEEK_PRO),
    });
    await resumed.agent.resume();
    resumed.mockNextResponse({ type: 'text', text: 'resumed answer' });
    await resumed.rpc.prompt({ input: [{ type: 'text', text: 'continue after resume' }] });
    await resumed.untilTurnEnd();

    expect(resumed.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(new Set(resumed.llmCalls[0]?.tools.map((tool) => tool.name))).toEqual(
      new Set(REQUIRED_TOOLS),
    );
  });

  it('keeps the bootstrap after an interrupted step produced no response', async () => {
    const ctx = configuredDeepSeekAgent(DEEPSEEK_PRO);
    ctx.agent.context.appendLoopEvent({
      type: 'step.begin',
      uuid: 'interrupted-anchor-step',
      turnId: '0',
      step: 1,
    });

    await runTextTurn(ctx, 'retry after interruption', 'answer');

    expect(ctx.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(ctx.llmCalls[0]?.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP_TOOLS);
  });

  it('re-anchors after clear and full compaction, but not after undo', async () => {
    const cleared = configuredDeepSeekAgent(DEEPSEEK_PRO);
    await runTextTurn(cleared, 'before clear', 'answer');
    await cleared.rpc.clearContext({});
    await runTextTurn(cleared, 'after clear', 'answer');
    expect(cleared.llmCalls[1]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);

    const compacted = configuredDeepSeekAgent(DEEPSEEK_PRO);
    await runTextTurn(compacted, 'before compaction', 'answer');
    compacted.agent.context.applyCompaction({
      summary: 'compacted context',
      compactedCount: compacted.agent.context.history.length,
      tokensBefore: 100,
      tokensAfter: 10,
    });
    await runTextTurn(compacted, 'after compaction', 'answer');
    expect(compacted.llmCalls[1]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);

    const undone = configuredDeepSeekAgent(DEEPSEEK_PRO);
    await runTextTurn(undone, 'before undo', 'answer');
    undone.agent.context.undo(1);
    await runTextTurn(undone, 'after undo', 'answer');
    expect(undone.llmCalls[1]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
  });

  it('leaves non-target models, subagents, and explicit modes unchanged', async () => {
    const regular = testAgent();
    regular.configure({ tools: [...REQUIRED_TOOLS] });
    await runTextTurn(regular, 'regular prompt', 'answer');
    expect(regular.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(regular.llmCalls[0]?.tools.map((tool) => tool.name)).not.toContain('bash');

    const subagent = configuredDeepSeekAgent(DEEPSEEK_PRO, { type: 'sub' });
    await runTextTurn(subagent, 'subagent prompt', 'answer');
    expect(subagent.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(subagent.llmCalls[0]?.tools.map((tool) => tool.name)).not.toContain('bash');

    const planning = configuredDeepSeekAgent(DEEPSEEK_PRO);
    planning.agent.planMode.restoreEnter({ id: 'test-plan' });
    await runTextTurn(planning, 'plan this task', 'plan answer');
    expect(planning.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(planning.llmCalls[0]?.tools.map((tool) => tool.name)).not.toContain('bash');
    expect(requestText(planning.llmCalls[0]!)).toContain('Plan mode is active');
  });

  it('fails open when a required canonical tool is not active', async () => {
    const ctx = testAgent();
    ctx.configure({
      tools: ['Bash'],
      provider: deepSeekProvider(DEEPSEEK_PRO),
    });
    ctx.agent.context.appendSystemReminder('keep this context', {
      kind: 'injection',
      variant: 'test',
    });

    await runTextTurn(ctx, 'limited tool prompt', 'answer');

    expect(ctx.llmCalls[0]?.systemPrompt).toBe(DEFAULT_TEST_SYSTEM_PROMPT);
    expect(ctx.llmCalls[0]?.tools.map((tool) => tool.name)).toEqual(['Bash']);
    expect(requestText(ctx.llmCalls[0]!)).toContain('keep this context');
  });
});

function configuredDeepSeekAgent(
  model: string,
  options: Parameters<typeof testAgent>[0] = {},
): TestAgentContext {
  const ctx = testAgent(options);
  ctx.configure({
    tools: [...REQUIRED_TOOLS],
    provider: deepSeekProvider(model),
  });
  return ctx;
}

function deepSeekProvider(model: string): ProviderConfig {
  return {
    type: 'lmcode',
    apiKey: 'test-key',
    model,
  };
}

function deepSeekConfig(model: string): LmcodeConfig {
  return {
    providers: {
      'test-provider': {
        type: 'lmcode',
        apiKey: 'test-key',
      },
    },
    models: {
      [model]: {
        provider: 'test-provider',
        model,
        maxContextSize: 1_000_000,
        capabilities: [],
      },
    },
  };
}

async function runTextTurn(
  ctx: TestAgentContext,
  prompt: string,
  response: string,
): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: response });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

function requestText(request: GenerateCall): string {
  return request.history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}
