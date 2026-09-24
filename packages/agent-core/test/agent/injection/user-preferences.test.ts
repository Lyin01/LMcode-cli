import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryMemo, type MemoryMemoSummary } from '@lmcode/memory';

import {
  UserPreferencesInjector,
  renderUserPreferenceLines,
} from '../../../src/agent/injection/user-preferences';
import { testAgent } from '../harness/agent';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // Windows can hold the freshly written SQLite files for a few seconds
    // (Defender-style scanners); give the removal a generous retry budget.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 100 });
  }
});

function summary(overrides: Partial<MemoryMemoSummary> = {}): MemoryMemoSummary {
  return {
    id: 'memo-1',
    sourceSessionId: 'session-1',
    userNeed: '所有会话',
    approach: '回复用中文',
    outcome: '已记录为长期偏好',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'manual',
    recordedAt: 1,
    projectDir: '',
    kind: 'preference',
    ...overrides,
  };
}

describe('renderUserPreferenceLines', () => {
  it('renders preference rules with their tags and skips task memos', () => {
    expect(
      renderUserPreferenceLines([
        summary({ tags: ['偏好', '沟通'] }),
        summary({ id: 'memo-2', approach: '修复构建', kind: 'task' }),
      ]),
    ).toBe('- 回复用中文（偏好、沟通）');
  });

  it('falls back to the scene (userNeed) when the rule text is blank', () => {
    expect(renderUserPreferenceLines([summary({ approach: '   ' })])).toBe('- 所有会话');
  });
});

describe('UserPreferencesInjector', () => {
  it('injects the preferences once and stays silent while the list is unchanged', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'hello', 'hi', 10);
    ctx.agent.renderUserPreferences = async () => '- 回复用中文';
    const injector = new UserPreferencesInjector(ctx.agent);

    const first = await injector.collectInjection();
    expect(first).toContain('- 回复用中文');
    expect(first).toContain('MemoryWrite');

    await injector.inject();
    expect(await injector.collectInjection()).toBeUndefined();
  });

  it('re-publishes when a newly learned preference changes the list', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'hello', 'hi', 10);
    let rendered = '- 回复用中文';
    ctx.agent.renderUserPreferences = async () => rendered;
    const injector = new UserPreferencesInjector(ctx.agent);

    await injector.inject();
    expect(await injector.collectInjection()).toBeUndefined();

    rendered = '- 回复用中文\n- 常用 pnpm';
    await expect(injector.collectInjection()).resolves.toContain('- 常用 pnpm');
  });

  it('re-publishes after a compaction consumes the previous injection', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'hello', 'hi', 10);
    ctx.agent.renderUserPreferences = async () => '- 回复用中文';
    const injector = new UserPreferencesInjector(ctx.agent);

    await injector.inject();
    expect(await injector.collectInjection()).toBeUndefined();

    injector.onContextCompacted(ctx.agent.context.history.length);
    await expect(injector.collectInjection()).resolves.toContain('- 回复用中文');
  });

  it('stays silent when the store has no preference memos', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'hello', 'hi', 10);
    const injector = new UserPreferencesInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('never injects into sub-agent contexts', async () => {
    const ctx = testAgent({ type: 'sub' });
    ctx.configure();
    ctx.agent.renderUserPreferences = async () => '- 回复用中文';
    const injector = new UserPreferencesInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('reads preference memos from the global store when a memory home is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'lmcode-pref-inject-'));
    tempDirs.push(homeDir);
    const ctx = testAgent({ lmcodeHomeDir: homeDir });
    ctx.configure();
    try {
      const store = ctx.agent.memoStore;
      expect(store).toBeDefined();
      // The harness installs the real fastembed engine; replace it so the test
      // neither downloads the ~91MB model nor schedules background embeddings.
      store!.setEmbeddingEngine({
        available: false,
        async embedBatch(): Promise<Float32Array[] | null> {
          return null;
        },
        cosineSimilarity(): number {
          return 0;
        },
      });
      await store!.append(
        createMemoryMemo({
          kind: 'preference',
          userNeed: '所有会话',
          approach: '回复用中文',
          outcome: '已记录为长期偏好',
          whatFailed: 'none',
          whatWorked: 'none',
          sourceSessionId: 'session-1',
          extractionSource: 'manual',
          tags: ['偏好', '沟通'],
        }),
      );
      await store!.append(
        createMemoryMemo({
          kind: 'task',
          userNeed: '修复构建',
          approach: '升级依赖',
          outcome: '完成',
          whatFailed: 'none',
          whatWorked: 'none',
          sourceSessionId: 'session-1',
          extractionSource: 'manual',
        }),
      );

      const rendered = await ctx.agent.renderUserPreferences();

      expect(rendered).toBe('- 回复用中文（偏好、沟通）');
      expect(rendered).not.toContain('修复构建');
    } finally {
      // Release the agent's own connection before the temp dir is removed.
      await ctx.agent.memoStore?.close().catch(() => {});
    }
  });
});
