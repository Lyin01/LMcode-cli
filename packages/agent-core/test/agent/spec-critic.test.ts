import type { GenerateResult, Message, ToolCall } from '@lmcode-cli/ltod';
import { createControlledPromise } from '@antfu/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommandJian, testAgent } from './harness/agent';

/**
 * Completion review: after a user-driven turn changes files, one bounded
 * utility-model pass reviews the request, the final response, and captured
 * mutation evidence. Only explicit SPEC_MISSING blockers continue the turn.
 */
describe('Spec-consistency critic', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('continues the turn once when the critic reports missing requirements', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    // Critic verdict.
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_MISSING:\n- also update the README' });
    // Continuation round triggered by the critic.
    ctx.mockNextResponse({ type: 'text', text: 'Updated the README as well.' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Write notes.txt and update the README' }],
    });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    const criticCall = ctx.llmCalls[2];
    expect(criticCall?.systemPrompt).toContain('final completion reviewer');
    const criticInput = messageText(criticCall?.history.at(-1));
    expect(criticInput).toContain('Original user request');
    expect(criticInput).toContain('Changed code evidence');
    expect(criticInput).toContain('hello world');
    expect(criticInput).toContain('Automatic validation evidence');
    expect(criticInput).toContain('Automatic post-write validation did not complete');

    const followupTexts = ctx.llmCalls[3]?.history.map(messageText) ?? [];
    expect(
      followupTexts.some((text) => text.includes('LMcode internal specification review')),
    ).toBe(true);
    expect(followupTexts.some((text) => text.includes('also update the README'))).toBe(true);
    const criticReminder = ctx.agent.context.history.find(
      (message) =>
        message.origin?.kind === 'system_trigger' && message.origin.name === 'spec_critic',
    );
    expect(messageText(criticReminder)).toContain('<system-reminder>');
    expect(messageText(criticReminder)).toContain('not a new user message');
    expect(
      ctx.agent.context.history.filter((message) => message.origin?.kind === 'user'),
    ).toHaveLength(1);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('prioritizes missing requirements over a contradictory SPEC_OK prefix', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({
      type: 'text',
      text: 'SPEC_OK\nSPEC_MISSING:\n- README was not updated',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Updated the README.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt and update README' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    const followupTexts = ctx.llmCalls[3]?.history.map(messageText) ?? [];
    expect(followupTexts.some((text) => text.includes('README was not updated'))).toBe(true);
  });

  it('fails open when the critic returns a non-protocol verdict', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({ type: 'text', text: 'Everything looks good overall.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt and update README' }] });
    await ctx.untilTurnEnd();

    const specCriticCalls = ctx.llmCalls.filter((call) =>
      call.systemPrompt.includes('final completion reviewer'),
    );
    expect(specCriticCalls).toHaveLength(1);
    expect(ctx.llmCalls).toHaveLength(3);
    expect(
      ctx.agent.context.history.some(
        (message) => message.origin?.kind === 'system_trigger' && message.origin.name === 'spec_critic',
      ),
    ).toBe(false);
  });

  it('completes the turn without continuation when the critic approves', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    const historyTexts = ctx.agent.context.history.map(messageText);
    expect(
      historyTexts.some((text) => text.includes('LMcode internal specification review')),
    ).toBe(false);
  });

  it('disables reviewer thinking so the utility pass stays bounded', async () => {
    const ctx = testAgent({
      jian: createCommandJian(''),
      initialConfig: { providers: {}, enableSelfHealing: false },
    });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    const utility = ctx.agent.config.utility;
    const withThinking = vi.spyOn(utility.provider, 'withThinking');
    vi.spyOn(ctx.agent.config, 'utility', 'get').mockReturnValue(utility);

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await ctx.untilTurnEnd();

    expect(withThinking).toHaveBeenCalledWith('off');
  });

  it('charges critic usage to the active goal before a later terminal update', async () => {
    const ctx = testAgent({
      jian: createCommandJian(''),
      initialConfig: { providers: {}, enableSelfHealing: false },
    });
    ctx.configure({ tools: ['Write', 'UpdateGoal'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Write notes and verify the result' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_goal_blocked',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'blocked' }),
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    const goal = ctx.agent.goal.getGoal().goal;
    expect(ctx.llmCalls).toHaveLength(4);
    expect(goal?.status).toBe('blocked');
    expect(goal?.tokensUsed).toBe(ctx.agent.usage.stats().totalTokens);
  });

  it('does not continue from a stale critic verdict after the goal is paused', async () => {
    const ctx = testAgent({
      jian: createCommandJian(''),
      initialConfig: { providers: {}, enableSelfHealing: false },
    });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Write notes without stale continuation' });
    const rawGenerate = ctx.agent.rawGenerate.bind(ctx.agent);
    const criticStarted = createControlledPromise<void>();
    const criticResponse = createControlledPromise<GenerateResult>();
    let mainCalls = 0;
    vi.spyOn(ctx.agent, 'rawGenerate').mockImplementation(async (...args) => {
      if (args[1].includes('final completion reviewer')) {
        criticStarted.resolve();
        return criticResponse;
      }
      mainCalls += 1;
      return rawGenerate(...args);
    });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    ctx.mockNextResponse({ type: 'text', text: 'Main model must not continue.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await criticStarted;
    await ctx.agent.goal.pauseGoal({ reason: 'Paused during specification review' });
    criticResponse.resolve({
      id: 'stale-spec-verdict',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'SPEC_MISSING:\n- add more detail' }],
        toolCalls: [],
      },
      usage: {
        inputOther: 7,
        output: 3,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'completed',
      rawFinishReason: 'stop',
    });
    await ctx.agent.turn.waitForCurrentTurn();

    expect(mainCalls).toBe(2);
    expect(
      ctx.agent.context.history.some(
        (message) =>
          message.origin?.kind === 'system_trigger' && message.origin.name === 'spec_critic',
      ),
    ).toBe(false);
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('paused');
  });

  it('skips the critic when enableSpecCritic is false', async () => {
    const ctx = testAgent({
      jian: createCommandJian(''),
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('skips the critic for direct answers even when the wording is highly constrained', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'Here is your answer.' });

    await ctx.rpc.prompt({
      input: [
        {
          type: 'text',
          text: 'Answer completely and strictly. You must give at least three reasons.',
        },
      ],
    });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('completes the turn when the critic call itself fails', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });
    // No third scripted response: the critic's generate call throws
    // "Unexpected generate call #3", which must be swallowed.

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('times out a stalled critic and completes the turn', async () => {
    const ctx = testAgent({ jian: createCommandJian('') });
    ctx.configure({ tools: ['Write'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    const rawGenerate = ctx.agent.rawGenerate.bind(ctx.agent);
    const criticStarted = createControlledPromise<void>();
    let criticSignal: AbortSignal | undefined;
    vi.spyOn(ctx.agent, 'rawGenerate').mockImplementation(async (...args) => {
      if (args[1].includes('final completion reviewer')) {
        criticSignal = args[5]?.signal;
        criticStarted.resolve();
        return new Promise<never>(() => {});
      }
      return rawGenerate(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    ctx.mockNextResponse(writeCall('call_w1', 'notes.txt'));
    ctx.mockNextResponse({ type: 'text', text: 'Done: wrote notes.txt.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write notes.txt' }] });
    await criticStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await ctx.untilTurnEnd();

    expect(criticSignal?.aborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });
});

function writeCall(id: string, path: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Write',
    arguments: JSON.stringify({ path, content: 'hello world\n' }),
  };
}

function messageText(message: Message | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}
