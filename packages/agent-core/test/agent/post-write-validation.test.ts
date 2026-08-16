import type { Message, ToolCall } from '@lmcode-cli/ltod';
import { createControlledPromise } from '@antfu/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as selfHealing from '../../src/utils/self-healing';
import { createCommandJian, testAgent } from './harness/agent';

const IMAGE_INPUT_CAPABILITIES = {
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

function pendingUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      try {
        signal.throwIfAborted();
        reject(new Error('Abort signal fired without an abort reason'));
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

describe('post-write validation evidence', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const finalStepText = ctx.llmCalls[1]?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('Automatic validation notice');
    expect(finalStepText).toContain('syntax validation was skipped');
    expect(finalStepText).toContain('Runtime behavior and visual output were not verified');
    expect(finalStepText).not.toContain("file's syntax passed");
  });

  it('does not call an LLM source reviewer after an ordinary write', async () => {
    const validate = vi
      .spyOn(selfHealing, 'validateFileSyntaxWithScreenshots')
      .mockResolvedValue({
        error: null,
        syntax: { status: 'passed' },
        runtime: { status: 'passed' },
        screenshots: undefined,
        keyframeTimesMs: undefined,
      });
    const ctx = await validationAgent();

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(validate).toHaveBeenCalledOnce();
    expect(ctx.llmCalls).toHaveLength(2);
    expect(
      ctx.llmCalls.some((call) => call.systemPrompt.includes('critical code reviewer')),
    ).toBe(false);
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
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const finalStepText = ctx.llmCalls[1]?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('active model cannot inspect images');
    expect(finalStepText).toContain(
      'Do not claim that appearance, animation timing, or the terminal frame was visually verified.',
    );
  });

  it('does not label a single 2-second screenshot as the terminal animation frame', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [2000],
    });
    const ctx = await validationAgent(false, true);

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'VISUAL_APPROVE' });
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    const visualCall = ctx.llmCalls.find((call) =>
      call.systemPrompt.includes('visual quality inspector'),
    );
    expect(visualCall?.systemPrompt).toContain('Screenshot 1: 2.0s');
    expect(visualCall?.systemPrompt).not.toContain('TERMINAL / end state');
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
    ctx.mockNextResponse(writeCall('call_write_2', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    const specCriticCall = ctx.llmCalls.find((call) =>
      call.systemPrompt.includes('final completion reviewer'),
    );
    const specCriticInput = messageText(specCriticCall?.history.at(-1));
    expect(specCriticInput).toContain('(none recorded; absence is not evidence that validation ran)');
    expect(specCriticInput).not.toContain('browser validation was skipped');
  });

  it('forwards an explicit runtime failure to the final reviewer when the model ignores it', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: 'Headless Playwright captured runtime errors:\nReferenceError: boom',
      syntax: { status: 'passed' },
      runtime: { status: 'failed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [0],
    });
    const ctx = await validationAgent(true);

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Everything passed and page.html is complete.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    const specCriticCall = ctx.llmCalls.find((call) =>
      call.systemPrompt.includes('final completion reviewer'),
    );
    const specCriticInput = messageText(specCriticCall?.history.at(-1));
    expect(specCriticInput).toContain('Automatic runtime validation failed');
    expect(specCriticInput).toContain('ReferenceError: boom');
  });

  it('forwards a visual rejection to the final reviewer when the model ignores it', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [2000],
    });
    const ctx = await validationAgent(true, true);

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'VISUAL_REJECT: the canvas is blank' });
    ctx.mockNextResponse({ type: 'text', text: 'page.html is complete.' });
    ctx.mockNextResponse({ type: 'text', text: 'SPEC_OK' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    const specCriticCall = ctx.llmCalls.find((call) =>
      call.systemPrompt.includes('final completion reviewer'),
    );
    const specCriticInput = messageText(specCriticCall?.history.at(-1));
    expect(specCriticInput).toContain('Automatic visual review rejected');
    expect(specCriticInput).toContain('canvas is blank');
  });

  it('reuses local validation for same-step duplicate writes', async () => {
    const validate = vi
      .spyOn(selfHealing, 'validateFileSyntaxWithScreenshots')
      .mockResolvedValue({
        error: null,
        syntax: { status: 'passed' },
        runtime: { status: 'passed' },
        screenshots: undefined,
        keyframeTimesMs: undefined,
      });
    const ctx = await validationAgent();

    ctx.mockNextResponse(
      writeCall('call_write_1', 'page.html'),
      writeCall('call_write_2', 'page.html'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await ctx.untilTurnEnd();

    expect(validate).toHaveBeenCalledTimes(1);
    expect(ctx.llmCalls).toHaveLength(2);
    const toolResults = ctx.agent.context.history.filter((message) => message.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(messageText(toolResults[1])).toBe(messageText(toolResults[0]));
  });

  it('cancels a pending local post-write validator through its signal', async () => {
    const validationStarted = createControlledPromise<void>();
    let validationSignal: AbortSignal | undefined;
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockImplementation(
      async (_path, _content, options) => {
        validationSignal = options?.signal;
        validationStarted.resolve();
        if (validationSignal === undefined) throw new Error('Validation signal is missing');
        return pendingUntilAborted(validationSignal);
      },
    );
    const ctx = await validationAgent();

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await validationStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(validationSignal?.aborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
  });

  it('cancels while reading the written file before local validation', async () => {
    const readStarted = createControlledPromise<void>();
    const validate = vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots');
    const ctx = await validationAgent();
    vi.spyOn(ctx.agent.jian, 'readText').mockImplementation(() => {
      readStarted.resolve();
      return new Promise<never>(() => {});
    });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await readStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(validate).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
  });

  it('cancels a pending visual review through the turn signal', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [2000],
    });
    const ctx = await validationAgent(false, true);
    const rawGenerate = ctx.agent.rawGenerate.bind(ctx.agent);
    const visualStarted = createControlledPromise<void>();
    let visualSignal: AbortSignal | undefined;
    vi.spyOn(ctx.agent, 'rawGenerate').mockImplementation(async (...args) => {
      if (args[2].length === 0 && args[1].startsWith('You are a visual quality inspector')) {
        visualSignal = args[5]?.signal;
        visualStarted.resolve();
        if (visualSignal === undefined) throw new Error('Visual review signal is missing');
        return pendingUntilAborted(visualSignal);
      }
      return rawGenerate(...args);
    });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await visualStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(visualSignal).toBeInstanceOf(AbortSignal);
    expect(visualSignal?.aborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
  });

  it('times out a visual review without cancelling the turn', async () => {
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockResolvedValue({
      error: null,
      syntax: { status: 'passed' },
      runtime: { status: 'passed' },
      screenshots: ['ZmFrZS1wbmc='],
      keyframeTimesMs: [2000],
    });
    const ctx = await validationAgent(false, true);
    const rawGenerate = ctx.agent.rawGenerate.bind(ctx.agent);
    const visualStarted = createControlledPromise<void>();
    let deadlineSignal: AbortSignal | undefined;
    vi.spyOn(ctx.agent, 'rawGenerate').mockImplementation(async (...args) => {
      if (args[2].length === 0 && args[1].startsWith('You are a visual quality inspector')) {
        deadlineSignal = args[5]?.signal;
        visualStarted.resolve();
        return new Promise<never>(() => {});
      }
      return rawGenerate(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await visualStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await ctx.untilTurnEnd();

    expect(deadlineSignal?.aborted).toBe(true);
    const finalStepText = ctx.llmCalls.at(-1)?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('visual auditor failed or timed out');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('times out a local validator without cancelling the turn', async () => {
    const validationStarted = createControlledPromise<void>();
    let deadlineSignal: AbortSignal | undefined;
    vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots').mockImplementation(
      async (_path, _content, options) => {
        deadlineSignal = options?.signal;
        validationStarted.resolve();
        return new Promise<never>(() => {});
      },
    );
    const ctx = await validationAgent();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html with limited validation.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await validationStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await ctx.untilTurnEnd();

    expect(deadlineSignal?.aborted).toBe(true);
    const finalStepText = ctx.llmCalls.at(-1)?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('overall result is inconclusive');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('times out a pending written-file read without cancelling the turn', async () => {
    const readStarted = createControlledPromise<void>();
    const validate = vi.spyOn(selfHealing, 'validateFileSyntaxWithScreenshots');
    const ctx = await validationAgent();
    vi.spyOn(ctx.agent.jian, 'readText').mockImplementation(() => {
      readStarted.resolve();
      return new Promise<never>(() => {});
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    ctx.mockNextResponse(writeCall('call_write', 'page.html'));
    ctx.mockNextResponse({ type: 'text', text: 'Created page.html with limited validation.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create page.html' }] });
    await readStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await ctx.untilTurnEnd();

    expect(validate).not.toHaveBeenCalled();
    const finalStepText = ctx.llmCalls.at(-1)?.history.map(messageText).join('\n') ?? '';
    expect(finalStepText).toContain('overall result is inconclusive');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });
});

async function validationAgent(enableSpecCritic = false, imageInput = false) {
  const jian = createCommandJian('');
  vi.spyOn(jian, 'readText').mockResolvedValue(
    '<!doctype html><html><body><canvas></canvas></body></html>',
  );
  const ctx = testAgent({
    jian,
    initialConfig: { providers: {}, enableSpecCritic },
  });
  ctx.configure({
    tools: ['Write'],
    modelCapabilities: imageInput ? IMAGE_INPUT_CAPABILITIES : undefined,
  });
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
