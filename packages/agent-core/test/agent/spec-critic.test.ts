import type { Message, ToolCall } from '@lmcode-cli/ltod';
import { describe, expect, it } from 'vitest';

import { createCommandJian, testAgent } from './harness/agent';

/**
 * Spec-consistency critic: when a user-driven turn that changed files, or a
 * high-constraint direct-answer request, stops naturally, one utility-model
 * pass reviews the original request against the final response. SPEC_MISSING
 * answers continue the turn once; everything else (SPEC_OK, disabled, low-risk
 * no-mutation answers, failures) completes it untouched.
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

  it('injects and enforces an action model for observable guarantee answers', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: '\u7b54\u6848\u662f 29\u3002' });
    ctx.mockNextResponse({
      type: 'text',
      text:
        '\u884c\u52a8\u6a21\u578b\uff1a\u5f62\u72b6\u53ef\u6478\u51fa\uff0c\u6240\u4ee5\u53ef\u4ee5\u5206\u522b\u51b3\u5b9a\u53d6 9 \u4e2a\u5706\u5f62\u548c 12 \u4e2a\u4e94\u89d2\u661f\u5f62\u3002\u7b54\u6848\u662f 21\u3002',
    });

    await ctx.rpc.prompt({
      input: [
        {
          type: 'text',
          text:
            '\u888b\u5b50\u91cc\u7cd6\u679c\u5f62\u72b6\u9760\u624b\u611f\u53ef\u5206\u8fa8\uff0c\u95ee\u6700\u5c11\u53d6\u591a\u5c11\u624d\u80fd\u4fdd\u8bc1\u6ee1\u8db3\u6761\u4ef6\u3002',
        },
      ],
    });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const firstCallTexts = ctx.llmCalls[0]?.history.map(messageText) ?? [];
    expect(
      firstCallTexts.some((text) => text.includes('Requirement-fidelity reminder')),
    ).toBe(true);
    expect(firstCallTexts.some((text) => text.includes('r ') && text.includes('s '))).toBe(
      true,
    );

    const followupTexts = ctx.llmCalls[1]?.history.map(messageText) ?? [];
    expect(
      followupTexts.some((text) => text.includes('Requirement-fidelity check')),
    ).toBe(true);
    expect(followupTexts.some((text) => text.includes('blind-pool'))).toBe(true);
  });

  it('reviews high-constraint direct answers even when no files changed', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.mockNextResponse({
      type: 'text',
      text:
        '\u884c\u52a8\u6a21\u578b\uff1a\u53d6 r \u4e2a\u5706\u5f62\u3001s \u4e2a\u4e94\u89d2\u661f\u5f62\u3002\u7b54\u6848\u662f 29\u3002',
    });
    ctx.mockNextResponse({
      type: 'text',
      text: 'SPEC_MISSING:\n- ignored that shapes can be distinguished by touch',
    });
    ctx.mockNextResponse({
      type: 'text',
      text: '行动模型：形状可摸出，所以应决定取多少圆形和多少五角星形。答案是 21。',
    });

    await ctx.rpc.prompt({
      input: [
        {
          type: 'text',
          text:
            '袋子里糖果形状可分辨，问最少取多少才能保证满足条件。',
        },
      ],
    });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    const criticCall = ctx.llmCalls[1];
    expect(criticCall?.systemPrompt).toContain('direct-answer responses');
    expect(criticCall?.systemPrompt).toContain('distinguished by touch');
    expect(messageText(criticCall?.history.at(-1))).toContain('Files the agent changed');
    expect(messageText(criticCall?.history.at(-1))).toContain('(none)');

    const followupTexts = ctx.llmCalls[2]?.history.map(messageText) ?? [];
    expect(followupTexts.some((text) => text.includes('Spec-consistency check'))).toBe(true);
    expect(
      followupTexts.some((text) => text.includes('ignored that shapes can be distinguished')),
    ).toBe(true);
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
