import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DreamTracker } from '@lmcode/memory';

import { testAgent } from '../harness/agent';

const NO_VISION_CAPS = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 200000,
};

const VISION_CAPS = { ...NO_VISION_CAPS, image_in: true };

// 1x1 透明 PNG
const IMG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('image degradation for non-vision models', () => {
  beforeEach(() => {
    vi.spyOn(DreamTracker.prototype, 'shouldSuggest').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('degrades image parts to a saved-path hint when the model lacks image_in', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'lmcode-img-degrade-'));
    const ctx = testAgent({ homedir });
    ctx.configure({ modelCapabilities: NO_VISION_CAPS });
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', imageUrl: { url: IMG_DATA_URL, id: 'image.png' } },
      ],
    });
    await ctx.untilTurnEnd();

    const history = ctx.lastLlmInput().input.history;
    const userMessage = history.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    const content = userMessage!.content;

    // 图片 part 不应到达模型
    expect(content.some((p) => p.type === 'image_url')).toBe(false);
    // 文本提示应提及 visual-mcp 与保存路径
    const texts = content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    expect(texts).toContain('ReadMediaFile');
    expect(texts).toContain('attachments');

    // 图片已落盘
    const dir = join(homedir, 'attachments');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toContain('image.png');
  });

  it('keeps image parts untouched when the model supports vision', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'lmcode-img-vision-'));
    const ctx = testAgent({ homedir });
    ctx.configure({ modelCapabilities: VISION_CAPS });
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: '看图' },
        { type: 'image_url', imageUrl: { url: IMG_DATA_URL, id: 'image.png' } },
      ],
    });
    await ctx.untilTurnEnd();

    const history = ctx.lastLlmInput().input.history;
    const userMessage = history.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage!.content.some((p) => p.type === 'image_url')).toBe(true);
    // 有视觉模型不应落盘
    expect(existsSync(join(homedir, 'attachments'))).toBe(false);
  });
});
