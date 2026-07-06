import type { ContentPart, Message, Tool } from '@lmcode-cli/ltod';
import { describe, expect, it } from 'vitest';

import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../../src/utils/tokens';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('charges ASCII at ~4 chars per token, rounding up', () => {
    expect(estimateTokens('a')).toBe(1); // ceil(1/4)
    expect(estimateTokens('abcd')).toBe(1); // ceil(4/4)
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokens('abcdefgh')).toBe(2); // ceil(8/4)
  });

  it('counts whitespace as ASCII', () => {
    expect(estimateTokens('    ')).toBe(1); // 4 spaces -> ceil(4/4)
  });

  it('charges CJK and other non-ASCII at ~1 char per token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('café')).toBe(2); // 3 ASCII -> ceil(3/4)=1, plus 'é' -> 1
  });

  it('sums ASCII and non-ASCII contributions independently', () => {
    // 'ab你' -> ceil(2/4)=1 ASCII token + 1 CJK token
    expect(estimateTokens('ab你')).toBe(2);
  });

  it('counts an astral-plane emoji (surrogate pair) as a single token', () => {
    // Iterated by code point, so the surrogate pair is one non-ASCII unit.
    expect(estimateTokens('😀')).toBe(1);
    expect(estimateTokens('ab😀')).toBe(2); // ceil(2/4)=1 + 1
  });
});

describe('estimateTokensForContentPart', () => {
  it('estimates text parts from their text', () => {
    const part: ContentPart = { type: 'text', text: 'hello world' };
    expect(estimateTokensForContentPart(part)).toBe(estimateTokens('hello world'));
  });

  it('estimates think parts from their reasoning text', () => {
    const part: ContentPart = { type: 'think', think: 'let me think about this' };
    expect(estimateTokensForContentPart(part)).toBe(estimateTokens('let me think about this'));
  });

  // Media parts are deliberately estimated as 0: their token cost cannot be
  // derived from a URL without fetching, and the transient estimate is
  // superseded by the provider's real count on the next round-trip. If media
  // estimation is ever added, update these expectations consciously.
  it('estimates image parts as 0 tokens', () => {
    const part: ContentPart = { type: 'image_url', imageUrl: { url: 'https://x/y.png' } };
    expect(estimateTokensForContentPart(part)).toBe(0);
  });

  it('estimates audio parts as 0 tokens', () => {
    const part: ContentPart = { type: 'audio_url', audioUrl: { url: 'https://x/y.mp3' } };
    expect(estimateTokensForContentPart(part)).toBe(0);
  });

  it('estimates video parts as 0 tokens', () => {
    const part: ContentPart = { type: 'video_url', videoUrl: { url: 'https://x/y.mp4' } };
    expect(estimateTokensForContentPart(part)).toBe(0);
  });
});

describe('estimateTokensForMessage', () => {
  it('counts the role plus every content part', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
      toolCalls: [],
    };
    expect(estimateTokensForMessage(message)).toBe(
      estimateTokens('user') + estimateTokens('hello') + estimateTokens('world'),
    );
  });

  it('counts tool call names and stringified arguments', () => {
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [
        { type: 'function', id: '1', name: 'read', arguments: '{"path":"a.ts"}' },
      ],
    };
    expect(estimateTokensForMessage(message)).toBe(
      estimateTokens('assistant') +
        estimateTokens('read') +
        estimateTokens(JSON.stringify('{"path":"a.ts"}')),
    );
  });

  it('handles a null tool-call arguments value without throwing', () => {
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [{ type: 'function', id: '1', name: 'noop', arguments: null }],
    };
    expect(estimateTokensForMessage(message)).toBe(
      estimateTokens('assistant') + estimateTokens('noop') + estimateTokens(JSON.stringify(null)),
    );
  });

  it('ignores media parts when summing a mixed-content message', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', imageUrl: { url: 'https://x/y.png' } },
      ],
      toolCalls: [],
    };
    expect(estimateTokensForMessage(message)).toBe(
      estimateTokens('user') + estimateTokens('look at this'),
    );
  });
});

describe('estimateTokensForMessages', () => {
  it('returns 0 for an empty list', () => {
    expect(estimateTokensForMessages([])).toBe(0);
  });

  it('sums the estimate across every message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }], toolCalls: [] },
    ];
    expect(estimateTokensForMessages(messages)).toBe(
      estimateTokensForMessage(messages[0]!) + estimateTokensForMessage(messages[1]!),
    );
  });
});

describe('estimateTokensForTools', () => {
  it('returns 0 for an empty tool list', () => {
    expect(estimateTokensForTools([])).toBe(0);
  });

  it('counts each tool name, description, and stringified parameters', () => {
    const tool: Tool = {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    };
    expect(estimateTokensForTools([tool])).toBe(
      estimateTokens('read_file') +
        estimateTokens('Read a file from disk') +
        estimateTokens(JSON.stringify(tool.parameters)),
    );
  });

  it('sums across multiple tools', () => {
    const tools: Tool[] = [
      { name: 'a', description: 'first', parameters: {} },
      { name: 'b', description: 'second', parameters: {} },
    ];
    expect(estimateTokensForTools(tools)).toBe(
      estimateTokensForTools([tools[0]!]) + estimateTokensForTools([tools[1]!]),
    );
  });
});
