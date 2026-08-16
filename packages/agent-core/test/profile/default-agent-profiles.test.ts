import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt).toContain('你是 LMcode');
    // Dynamic content (skills, cwd) stays in session-context.md for cache stability.
    expect(prompt).toContain('当前可用的技能列表见会话开头的「当前会话环境」');
    expect(prompt).not.toContain('/workspace');
    expect(prompt).toContain('以用户最新的明确请求为本轮目标');
    expect(prompt).toContain('修改前先读取相关实现和项目约定');
    expect(prompt).toContain('验证强度与改动风险和影响范围匹配');
    expect(prompt).toContain('不要静默遗漏');
    expect(prompt).not.toContain('行动模型');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(12_000);
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('keeps the compact default prompt section numbering sequential', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    // Hand-numbered Chinese section headers have regressed twice (a skipped
    // `### 3.` and 二十 placed before 十九); the rendered prompt is the
    // contract the model actually sees, so guard the ordering here.
    const expectedSections = ['一', '二', '三', '四', '五', '六', '七'];
    const topLevel = [...prompt.matchAll(/^## (.+?)、/gm)].map((m) => m[1]);
    expect(topLevel).toEqual(expectedSections);

    const sections = prompt.split(/^## /gm).slice(1);
    for (const section of sections) {
      const numbers = [...section.matchAll(/^### (\d+)\./gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    }
  });
});
