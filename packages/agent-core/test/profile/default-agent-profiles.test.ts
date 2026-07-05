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
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('你是 LMcode');
    expect(prompt).toContain('当前可用的技能列表');
    expect(prompt).toContain('/workspace');
    expect(prompt).toContain('需求保真');
    expect(prompt).toContain('用户的当前提示词是本轮任务的事实来源');
    expect(prompt).toContain('所有任务，而不仅是软件工程任务');
    expect(prompt).toContain('括号、插入语');
    expect(prompt).toContain('视为一等约束');
    expect(prompt).toContain('TodoList');
    expect(prompt).toContain('不要静默遗漏');
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
