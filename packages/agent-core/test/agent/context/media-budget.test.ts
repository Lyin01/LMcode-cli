import {
  APIRequestTooLargeError,
  type ChatProvider,
  type Message,
} from '@lmcode-cli/liumir';
import { describe, expect, it } from 'vitest';

import type { AgentOptions } from '../../../src/agent';
import {
  applyMediaBudget,
  DEFAULT_MEDIA_BUDGET_BYTES,
  DEFAULT_MEDIA_TOOL_RESULT_IMAGE_LIMIT,
  mediaPayloadBytes,
} from '../../../src/agent/context/media-budget';
import { testAgent } from '../harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const DATA_PREFIX = 'data:image/png;base64,';
const BIG_CHUNK = 3_000_000;

function textPart(text: string): Message['content'][number] {
  return { type: 'text', text };
}

function imagePart(payload: string): Message['content'][number] {
  return { type: 'image_url', imageUrl: { url: `${DATA_PREFIX}${payload}` } };
}

function message(role: Message['role'], ...content: Message['content']): Message {
  return { role, content, toolCalls: [] };
}

function countInlineMedia(messages: readonly Message[]): number {
  let count = 0;
  for (const entry of messages) {
    for (const part of entry.content) {
      if (part.type === 'image_url' && part.imageUrl.url.startsWith('data:')) {
        count += 1;
      }
    }
  }
  return count;
}

describe('mediaPayloadBytes', () => {
  it('sums only inline data-url media across messages', () => {
    const messages = [
      message('user', textPart('hello'), imagePart('x'.repeat(10))),
      message('tool', imagePart('y'.repeat(20))),
    ];
    expect(mediaPayloadBytes(messages)).toBe(
      DATA_PREFIX.length + 10 + (DATA_PREFIX.length + 20),
    );
  });

  it('ignores non-inline urls (https / blobref)', () => {
    const messages = [
      message('user', { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }),
      message('tool', { type: 'image_url', imageUrl: { url: 'blobref:image/png;deadbeef' } }),
    ];
    expect(mediaPayloadBytes(messages)).toBe(0);
  });
});

describe('applyMediaBudget', () => {
  it('returns the input unchanged when everything fits', () => {
    const messages = [message('user', textPart('hi'), imagePart('aaa'))];
    expect(applyMediaBudget(messages, DEFAULT_MEDIA_BUDGET_BYTES)).toBe(messages);
  });

  it('keeps the newest media first and replaces only what does not fit', () => {
    const messages = [
      message('tool', imagePart('o'.repeat(200))),
      message('user', textPart('look'), imagePart('m'.repeat(40))),
      message('assistant', imagePart('n'.repeat(20))),
    ];
    const original = JSON.parse(JSON.stringify(messages)) as Message[];

    const budgeted = applyMediaBudget(messages, 120);

    // Newest (prefix+20) + middle (prefix+40) fit within 120; the older
    // prefix+200 part is replaced.
    expect(budgeted[2]).toBe(messages[2]);
    expect(budgeted[1]).toBe(messages[1]);
    expect(budgeted[0]!.content[0]!.type).toBe('text');
    expect(mediaPayloadBytes(budgeted)).toBe(DATA_PREFIX.length * 2 + 20 + 40);
    // The input is never mutated (copy-on-write).
    expect(JSON.parse(JSON.stringify(messages))).toEqual(original);
  });

  it('always keeps the most recent media part even when it alone exceeds the budget', () => {
    const messages = [
      message('tool', imagePart('o'.repeat(200))),
      message('user', imagePart('n'.repeat(500))),
    ];

    const budgeted = applyMediaBudget(messages, 4);

    expect(budgeted[0]!.content[0]!.type).toBe('text');
    expect(budgeted[1]).toBe(messages[1]);
    expect(mediaPayloadBytes(budgeted)).toBe(DATA_PREFIX.length + 500);
  });

  it('drops every inline media part when the budget is zero', () => {
    const messages = [
      message('tool', imagePart('a'.repeat(10))),
      message('user', textPart('keep'), imagePart('b'.repeat(10))),
    ];

    const budgeted = applyMediaBudget(messages, 0);

    expect(mediaPayloadBytes(budgeted)).toBe(0);
    expect(budgeted[1]!.content[0]).toEqual({ type: 'text', text: 'keep' });
    expect(budgeted[1]!.content[1]!.type).toBe('text');
  });

  it('leaves non-inline media untouched', () => {
    const https = message('user', {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/a.png' },
    });
    const messages = [https];

    const budgeted = applyMediaBudget(messages, 0);

    expect(budgeted).toBe(messages);
    expect(budgeted[0]).toBe(https);
  });
});

describe('applyMediaBudget tool-result image limit', () => {
  it('keeps only the newest tool-result images and leaves user media alone', () => {
    const messages = [
      message('tool', imagePart('1')),
      message('tool', imagePart('2')),
      message('tool', imagePart('3')),
      message('user', imagePart('u')),
      message('tool', imagePart('4')),
    ];

    const budgeted = applyMediaBudget(messages, DEFAULT_MEDIA_BUDGET_BYTES, 2);

    // Newest tool images (4, 3) stay inline; the older two are replaced.
    expect(budgeted[4]).toBe(messages[4]);
    expect(budgeted[2]).toBe(messages[2]);
    expect(budgeted[1]!.content[0]!.type).toBe('text');
    expect(budgeted[0]!.content[0]!.type).toBe('text');
    // User-authored media is exempt from the count cap.
    expect(budgeted[3]).toBe(messages[3]);
  });

  it('drops every tool-result image at a zero limit but keeps user images', () => {
    const messages = [message('tool', imagePart('a')), message('user', imagePart('b'))];

    const budgeted = applyMediaBudget(messages, DEFAULT_MEDIA_BUDGET_BYTES, 0);

    expect(budgeted[0]!.content[0]!.type).toBe('text');
    expect(budgeted[1]).toBe(messages[1]);
  });

  it('applies the default keep-newest limit when no explicit limit is given', () => {
    const messages = Array.from({ length: DEFAULT_MEDIA_TOOL_RESULT_IMAGE_LIMIT + 3 }, () =>
      message('tool', imagePart('x')),
    );

    const budgeted = applyMediaBudget(messages, DEFAULT_MEDIA_BUDGET_BYTES);

    // The three oldest images are replaced; the newest default-limit stay.
    for (let index = 0; index < 3; index += 1) {
      expect(budgeted[index]!.content[0]!.type).toBe('text');
    }
    for (let index = 3; index < budgeted.length; index += 1) {
      expect(budgeted[index]!.content[0]!.type).toBe('image_url');
    }
  });
});

describe('Agent.generate media budget healing', () => {
  function fakeProvider(): ChatProvider {
    return {
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      generate: () => {
        throw new Error('provider.generate is not used in this test');
      },
    } as unknown as ChatProvider;
  }

  function createGenerateThatFails(failures: number): {
    generate: GenerateFn;
    calls: Message[][];
  } {
    const calls: Message[][] = [];
    let remainingFailures = failures;
    const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history) => {
      calls.push([...history]);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new APIRequestTooLargeError('413 Request Entity Too Large');
      }
      return {
        id: `fake-${String(calls.length)}`,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: null,
      };
    };
    return { generate, calls };
  }

  function trimWarnings(ctx: ReturnType<typeof testAgent>): string[] {
    return ctx.allEvents
      .filter(
        (event) =>
          event.type === '[rpc]' &&
          event.event === 'warning' &&
          (event.args as { code?: string }).code === 'llm_request_media_trimmed',
      )
      .map((event) => (event.args as { message?: string }).message ?? '');
  }

  function bigHistory(): Message[] {
    return [
      message('tool', imagePart('a'.repeat(BIG_CHUNK))),
      message('tool', imagePart('b'.repeat(BIG_CHUNK))),
      message('tool', imagePart('c'.repeat(BIG_CHUNK))),
    ];
  }

  it('trims older media and retries after a payload-too-large failure', async () => {
    const { generate, calls } = createGenerateThatFails(1);
    const ctx = testAgent({ generate });
    ctx.configure();

    const history = bigHistory();
    const result = await ctx.agent.generate(
      fakeProvider(),
      'sys',
      [],
      history,
      undefined,
      undefined,
    );

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toHaveLength(2);
    // First attempt carried the full history; the retry kept only the newest
    // image and replaced the two older ones with placeholders.
    expect(countInlineMedia(calls[0]!)).toBe(3);
    expect(countInlineMedia(calls[1]!)).toBe(1);
    expect(mediaPayloadBytes(calls[1]!)).toBe(mediaPayloadBytes([history[2]!]));
    expect(trimWarnings(ctx)).toHaveLength(1);
  });

  it('falls back to dropping all inline media when the reduced retry still fails', async () => {
    const { generate, calls } = createGenerateThatFails(2);
    const ctx = testAgent({ generate });
    ctx.configure();

    const result = await ctx.agent.generate(
      fakeProvider(),
      'sys',
      [],
      bigHistory(),
      undefined,
      undefined,
    );

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toHaveLength(3);
    expect(countInlineMedia(calls[1]!)).toBe(1);
    expect(countInlineMedia(calls[2]!)).toBe(0);
    expect(trimWarnings(ctx)).toHaveLength(2);
  });

  it('rethrows without retrying when no inline media can be trimmed', async () => {
    const { generate, calls } = createGenerateThatFails(1);
    const ctx = testAgent({ generate });
    ctx.configure();

    await expect(
      ctx.agent.generate(
        fakeProvider(),
        'sys',
        [],
        [message('user', textPart('hello'))],
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(APIRequestTooLargeError);

    expect(calls).toHaveLength(1);
    expect(trimWarnings(ctx)).toHaveLength(0);
  });

  it('leaves other generate failures untouched', async () => {
    const calls: Message[][] = [];
    const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history) => {
      calls.push([...history]);
      throw new Error('boom');
    };
    const ctx = testAgent({ generate });
    ctx.configure();

    await expect(
      ctx.agent.generate(
        fakeProvider(),
        'sys',
        [],
        [message('tool', imagePart('a'.repeat(64)))],
        undefined,
        undefined,
      ),
    ).rejects.toThrow('boom');
    expect(calls).toHaveLength(1);
  });
});
