import type { Message } from '@lmcode-cli/liumir';
import { describe, expect, it } from 'vitest';

import { testAgent } from './harness/agent';

/**
 * When a reasoning model spends the output budget on thinking and returns no
 * text or tool calls, the turn continues once with a reminder instead of
 * failing as an empty response.
 */
describe('think-only truncated reasoning continuation', () => {
  it('continues the turn once after a think-only response', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure();

    ctx.mockNextResponse({ type: 'think', think: 'I will solve every problem in this block...' });
    ctx.mockNextResponse({ type: 'text', text: 'Here is the first answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Do the exam' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const reminder = ctx.agent.context.history.find(
      (message) =>
        message.origin?.kind === 'system_trigger' && message.origin.name === 'thinking_truncated',
    );
    expect(messageText(reminder)).toContain('<system-reminder>');
    expect(messageText(reminder)).toContain('only reasoning');
    const followupTexts = ctx.llmCalls[1]?.history.map(messageText) ?? [];
    expect(followupTexts.some((text) => text.includes('only reasoning'))).toBe(true);
  });

  it('does not loop when the continuation is also think-only', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure();

    ctx.mockNextResponse({ type: 'think', think: 'first pass' });
    ctx.mockNextResponse({ type: 'think', think: 'second pass still no answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Do the exam' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
  });
});

function messageText(message: Message | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
