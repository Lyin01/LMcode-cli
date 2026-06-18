import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UsagePanelComponent', () => {
  it('formats session, context, and managed usage sections', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          scream: {
            inputOther: 1000,
            inputCacheRead: 500,
            inputCacheCreation: 500,
            output: 250,
          },
        },
      } as never,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      managedUsage: {
        summary: {
          label: 'daily',
          used: 20,
          limit: 100,
          resetHint: 'resets tomorrow',
        },
        limits: [],
      },
    }).map(strip);

    expect(lines).toContain('会话用量');
    expect(lines).toContain('  scream  输入 2.0k  输出 250  总计 2.3k');
    expect(lines).toContain('上下文窗口');
    expect(lines.join('\n')).toContain('25.0%');
    expect(lines).toContain('计划用量');
    expect(lines.join('\n')).toContain('20% 已用');
    expect(lines.join('\n')).toContain('resets tomorrow');
  });

  it('reports prompt-cache hit rate from inputCacheRead', () => {
    const text = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          'deepseek/deepseek-v4-flash': {
            inputOther: 200,
            inputCacheRead: 800,
            inputCacheCreation: 0,
            output: 50,
          },
        },
      } as never,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
    })
      .map(strip)
      .join('\n');

    // 800 cache-read / 1000 total input = 80.0%
    expect(text).toContain('缓存命中');
    expect(text).toContain('80.0%');
    expect(text).toContain('(800 / 1.0k 输入)');
  });

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' 用量 ');
    expect(output[1]).toContain('会话用量');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent([longLine], darkColors.primary);
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('caches render output for the same width', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate()', () => {
    const component = new UsagePanelComponent(['会话用量'], darkColors.primary);

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
