import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryMemo, type MemoryMemoSummary } from '@lmcode/memory';

import {
  PendingTasksInjector,
  renderPendingTaskLines,
} from '../../../src/agent/injection/pending-tasks';
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

function memo(overrides: Partial<MemoryMemoSummary> = {}): MemoryMemoSummary {
  return {
    id: 'memo-1',
    sourceSessionId: 'session-1',
    userNeed: '修复 flaky test',
    approach: '已定位到 Windows 文件锁',
    outcome: '未完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'exit',
    recordedAt: 0,
    projectDir: '',
    kind: 'pending',
    ...overrides,
  };
}

describe('renderPendingTaskLines', () => {
  const now = new Date(2026, 8, 24, 12, 0, 0).getTime();

  it('renders task, progress and age for pending memos', () => {
    const lines = renderPendingTaskLines(
      [
        memo({
          userNeed: '修复 flaky test',
          approach: '已定位到 Windows 文件锁，下一步验证重试预算',
          recordedAt: now - 2 * 86_400_000,
        }),
      ],
      { now },
    );

    expect(lines).toBe(
      '- 修复 flaky test · 进度：已定位到 Windows 文件锁，下一步验证重试预算（2 天前）',
    );
  });

  it('skips non-pending memos, stale entries and records without a task', () => {
    const lines = renderPendingTaskLines(
      [
        memo({ id: 'a', kind: 'task', userNeed: '完成的任务', recordedAt: now }),
        memo({ id: 'b', kind: 'preference', userNeed: '回复用中文', recordedAt: now }),
        memo({ id: 'c', userNeed: '过期任务', recordedAt: now - 15 * 86_400_000 }),
        memo({ id: 'd', userNeed: '   ', recordedAt: now }),
        memo({ id: 'e', userNeed: '进行中的任务', recordedAt: now - 60_000 }),
      ],
      { now },
    );

    expect(lines).toBe('- 进行中的任务 · 进度：已定位到 Windows 文件锁（1 分钟前）');
  });

  it('carries at most `limit` pending tasks', () => {
    const lines = renderPendingTaskLines(
      [
        memo({ id: 'a', userNeed: '任务 A', recordedAt: now }),
        memo({ id: 'b', userNeed: '任务 B', recordedAt: now }),
        memo({ id: 'c', userNeed: '任务 C', recordedAt: now }),
      ],
      { now, limit: 2 },
    );

    expect(lines).toContain('任务 A');
    expect(lines).toContain('任务 B');
    expect(lines).not.toContain('任务 C');
  });

  it('omits the progress segment when the approach is blank and collapses whitespace', () => {
    const blank = renderPendingTaskLines(
      [memo({ userNeed: '任务', approach: '   ', recordedAt: now })],
      { now },
    );
    expect(blank).toBe('- 任务（刚刚）');

    const wrapped = renderPendingTaskLines(
      [memo({ userNeed: '任务', approach: 'first\n\nsecond   line', recordedAt: now })],
      { now },
    );
    expect(wrapped).toBe('- 任务 · 进度：first second line（刚刚）');
  });
});

describe('PendingTasksInjector', () => {
  it('briefs a fresh session once and then stays silent', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: '继续' }]);
    ctx.agent.renderPendingTasks = async () => '- 修复 flaky test（2 天前）';
    const injector = new PendingTasksInjector(ctx.agent);

    const first = await injector.collectInjection();
    expect(first).toContain('修复 flaky test');
    expect(first).toContain('MemoryEdit');
    expect(first).toContain('销账');

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('stays silent once the history is past the fresh-session window', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'one' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'two' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'three' }]);
    let called = false;
    ctx.agent.renderPendingTasks = async () => {
      called = true;
      return '- x';
    };
    const injector = new PendingTasksInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it('never injects into sub-agent contexts', async () => {
    const ctx = testAgent({ type: 'sub' });
    ctx.configure();
    ctx.agent.renderPendingTasks = async () => '- x';
    const injector = new PendingTasksInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('stays silent when the memory lookup fails', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.agent.renderPendingTasks = async () => {
      throw new Error('store unavailable');
    };
    const injector = new PendingTasksInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });
});

describe('Agent.renderPendingTasks', () => {
  it('reads pending memos from the store and skips other kinds', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'lmcode-pending-inject-'));
    tempDirs.push(homeDir);
    const ctx = testAgent({ lmcodeHomeDir: homeDir });
    ctx.configure();
    try {
      const store = ctx.agent.memoStore;
      expect(store).toBeDefined();
      // Keep the real fastembed engine out of this test so it neither
      // downloads the model nor schedules background embeddings.
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
          kind: 'pending',
          userNeed: '修复 flaky test',
          approach: '已定位到文件锁，下一步验证重试预算',
          outcome: '未完成',
          whatFailed: 'none',
          whatWorked: 'none',
          sourceSessionId: 'session-1',
          extractionSource: 'exit',
        }),
      );
      await store!.append(
        createMemoryMemo({
          kind: 'task',
          userNeed: '完成的任务',
          approach: '升级依赖',
          outcome: '完成',
          whatFailed: 'none',
          whatWorked: 'none',
          sourceSessionId: 'session-1',
          extractionSource: 'exit',
        }),
      );
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
        }),
      );

      const rendered = await ctx.agent.renderPendingTasks();

      expect(rendered).toContain('修复 flaky test');
      expect(rendered).toContain('进度：已定位到文件锁');
      expect(rendered).not.toContain('完成的任务');
      expect(rendered).not.toContain('回复用中文');
    } finally {
      // Release the agent's own connection before the temp dir is removed.
      await ctx.agent.memoStore?.close().catch(() => {});
    }
  });
});
