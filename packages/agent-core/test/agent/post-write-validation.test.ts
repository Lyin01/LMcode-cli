import type { Message, ToolCall } from '@lmcode-cli/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as selfHealing from '../../src/utils/self-healing';
import { createCommandJian, testAgent } from './harness/agent';

describe('post-write validation evidence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the write successful but tells the model when browser validation was skipped', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: {
        status: 'skipped',
        reason: 'typescript-unavailable',
        detail: undefined,
      },
      runtime: {
        status: 'skipped',
        reason: 'playwright-unavailable',
        detail: undefined,
      },
      screenshots: undefined,
      keyframeTimesMs: undefined,
    });
    const ctx = await validationAgent();

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'APPROVE' });
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    const finalStepText = ctx.llmCalls[2]?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('Automatic validation notice');
    expect(finalStepText).toContain('syntax validation was skipped');
    expect(finalStepText).toContain('Runtime behavior and visual output were not verified');
    expect(finalStepText).not.toContain("file's syntax passed");
  });

  it('does not describe captured keyframes as visually reviewed without image input', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [0],
    });
    const ctx = await validationAgent();

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'APPROVE' });
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.llmCalls[1]?.systemPrompt).toContain('critical code reviewer');
    const finalStepText = ctx.llmCalls[2]?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('active model cannot inspect images');
    expect(finalStepText).toContain('terminal frame was visually verified');
  });

  it('removes an earlier limitation after the same file passes revalidation', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots')
      .mockResolvedValueOnce({
        error: null,
        syntax: { status: 'passed' },
        runtime: {
          status: 'skipped',
          reason: 'playwright-unavailable',
          detail: undefined,
        },
        screenshots: undefined,
        keyframeTimesMs: undefined,
      })
      .mockResolvedValueOnce({
        error: null,
        syntax: { status: 'passed' },
        runtime: { status: 'passed' },
        screenshots: undefined,
        keyframeTimesMs: undefined,
      });
    const ctx = await validationAgent(true);

    ctx.mockNextResponse(writeCall('call_write_1', './page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'APPROVE' });
    ctx.mockNextResponse(writeCall('call_write_2', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'APPROVE' });
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    const specCriticCall = ctx.llmCalls.find((call) =>
      call.systemPrompt.includes('specification-compliance reviewer'),
    );
    const specCriticInput = messageText(specCriticCall?.history.at(-1));
    expect(specCriticInput).toContain('(none recorded; absence is not evidence that validation ran)');
    expect(specCriticInput).not.toContain('browser validation was skipped');
  });

  it('reports a source-review failure without discarding successful syntax and runtime evidence', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: undefined,
      keyframeTimesMs: undefined,
    });
    const ctx = await validationAgent();
    const rawGenerate = ctx.agent.rawGenerate.bind(ctx.agent);
    vi.spyOn(ctx.agent, 'rawGenerate').mockImplementation(async (...args) => {
      if (args[1].includes('critical code reviewer')) {
        throw new Error('critic unavailable');
      }
      return rawGenerate(...args);
    });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    const finalStepText = ctx.llmCalls[1]?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('source review failed or timed out');
    expect(finalStepText).not.toContain('overall result is inconclusive');
    expect(finalStepText).not.toContain('Do not claim syntax, runtime, or visual verification');
  });
});

async function validationAgent(enableSpecCritic = false) {
  const jian = createCommandJian('');
  vi.spyOn(jian, 'readText').mockResolvedValue(
    '<!doctype html><html><body><canvas></canvas></body></html>',
  );
  const ctx = testAgent({
    jian,
    initialConfig: { providers: {}, enableSpecCritic },
  });
  ctx.configure({ tools: ['Write'] });
  await ctx.rpc.setPermission({ mode: 'yolo' });
  return ctx;
}

function writeCall(id: string, path: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Write',
    arguments: JSON.stringify({
      path,
      content: '<!doctype html><html><body><canvas></canvas></body></html>',
    }),
  };
}

function messageText(message: Message | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}
