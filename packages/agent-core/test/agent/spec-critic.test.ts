import type { Message, ToolCall } from '@lmcode-cli/ltod';
import { describe, expect, it } from 'vitest';

import { createCommandJian, testAgent } from './harness/agent';

/**
 * Spec-consistency critic: when a user-driven turn that changed files stops
 * naturally, one utility-model pass reviews the original request against the
 * final response. SPEC_MISSING answers continue the turn once; everything
 * else (SPEC_OK, disabled, no mutations, failures) completes it untouched.
 */
describe('Spec-consistency critic', () => {
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
    expect(criticCall?.systemPrompt).toContain('specification-compliance reviewer');
    expect(messageText(criticCall?.history.at(-1))).toContain('Original user request');

    const followupTexts = ctx.llmCalls[3]?.history.map(messageText) ?? [];
    expect(followupTexts.some((text) => text.includes('Spec-consistency check'))).toBe(true);
    expect(followupTexts.some((text) => text.includes('also update the README'))).toBe(true);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
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
    expect(historyTexts.some((text) => text.includes('Spec-consistency check'))).toBe(false);
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

  it('skips the critic when the turn changed no files', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'Here is your answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Just answer a question' }] });
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
