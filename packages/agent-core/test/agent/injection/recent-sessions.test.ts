import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RecentSessionsInjector,
  formatSessionAge,
  renderRecentSessionLines,
} from '../../../src/agent/injection/recent-sessions';
import type { SessionSummary } from '../../../src/rpc/core-api';
import { SessionStore } from '../../../src/session/store';
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

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-a',
    workDir: '/work/lmcode-desktop-source',
    sessionDir: '/home/.lmcode/sessions/key/session-a',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('formatSessionAge', () => {
  it('covers the minute, hour, day and date ranges', () => {
    const now = new Date(2026, 8, 24, 12, 0, 0).getTime();

    expect(formatSessionAge(now, now - 30_000)).toBe('刚刚');
    expect(formatSessionAge(now, now - 5 * 60_000)).toBe('5 分钟前');
    expect(formatSessionAge(now, now - 3 * 3_600_000)).toBe('3 小时前');
    expect(formatSessionAge(now, now - 2 * 86_400_000)).toBe('2 天前');
    expect(formatSessionAge(now, new Date(2026, 7, 1, 12, 0, 0).getTime())).toBe('2026-08-01');
  });
});

describe('renderRecentSessionLines', () => {
  const now = new Date(2026, 8, 24, 12, 0, 0).getTime();

  it('renders project, title, last prompt and age for each session', () => {
    const lines = renderRecentSessionLines(
      [
        summary({
          id: 'a',
          title: 'Fix the build',
          lastPrompt: 'run the tests',
          updatedAt: now - 2 * 3_600_000,
        }),
        summary({
          id: 'b',
          workDir: '/work/blog',
          title: 'Write docs',
          updatedAt: now - 2 * 86_400_000,
        }),
      ],
      { now },
    );

    expect(lines).toBe(
      [
        '- [lmcode-desktop-source] Fix the build · 最后一句：「run the tests」（2 小时前）',
        '- [blog] Write docs（2 天前）',
      ].join('\n'),
    );
  });

  it('skips the current session, archived sessions and records without content', () => {
    const lines = renderRecentSessionLines(
      [
        summary({ id: 'self', title: 'This session' }),
        summary({ id: 'archived', title: 'Old work', archived: true }),
        summary({ id: 'empty' }),
        summary({ id: 'past', lastPrompt: 'keep going', updatedAt: now }),
      ],
      { now, selfSessionId: 'self' },
    );

    expect(lines).toBe('- [lmcode-desktop-source] 最后一句：「keep going」（刚刚）');
  });

  it('carries at most `limit` sessions', () => {
    const lines = renderRecentSessionLines(
      [
        summary({ id: 'a', title: 'First' }),
        summary({ id: 'b', title: 'Second' }),
        summary({ id: 'c', title: 'Third' }),
      ],
      { now, limit: 2 },
    );

    expect(lines).toContain('First');
    expect(lines).toContain('Second');
    expect(lines).not.toContain('Third');
  });

  it('collapses whitespace and truncates an oversized last prompt', () => {
    const lines = renderRecentSessionLines(
      [summary({ id: 'a', lastPrompt: `first line\n\nsecond   line ${'x'.repeat(200)}` })],
      { now },
    );

    expect(lines).not.toContain('\n');
    expect(lines).toContain('最后一句：「first line second line');
    expect(lines).toContain('…」');
  });
});

describe('RecentSessionsInjector', () => {
  it('briefs a fresh session once and then stays silent', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: '继续' }]);
    ctx.agent.renderRecentSessions = async () => '- [lmcode-desktop-source] Fix the build（2 小时前）';
    const injector = new RecentSessionsInjector(ctx.agent);

    const first = await injector.collectInjection();
    expect(first).toContain('Fix the build');
    expect(first).toContain('如果对不上号');

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('stays silent once the history is past the fresh-session window', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'one' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'two' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'three' }]);
    let called = false;
    ctx.agent.renderRecentSessions = async () => {
      called = true;
      return '- x';
    };
    const injector = new RecentSessionsInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it('never injects into sub-agent contexts', async () => {
    const ctx = testAgent({ type: 'sub' });
    ctx.configure();
    ctx.agent.renderRecentSessions = async () => '- x';
    const injector = new RecentSessionsInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });

  it('stays silent when the session lookup is unavailable', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.agent.renderRecentSessions = async () => {
      throw new Error('store unavailable');
    };
    const injector = new RecentSessionsInjector(ctx.agent);

    await expect(injector.collectInjection()).resolves.toBeUndefined();
  });
});

describe('Agent.renderRecentSessions', () => {
  it('reads other sessions from the store and excludes the current one', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'lmcode-recent-inject-'));
    tempDirs.push(homeDir);
    const store = new SessionStore(homeDir);
    const selfWorkDir = join(homeDir, 'project-self');
    await store.create({ id: 'self-session', workDir: selfWorkDir });
    const selfDir = store.sessionDirFor({ id: 'self-session', workDir: selfWorkDir });
    await writeFile(
      join(selfDir, 'state.json'),
      JSON.stringify({ title: 'This very session', lastPrompt: 'hello' }),
    );
    const past = await store.create({ id: 'past-session', workDir: join(homeDir, 'project-past') });
    await writeFile(
      join(past.sessionDir, 'state.json'),
      JSON.stringify({ title: 'Fix the build', lastPrompt: 'run the tests' }),
    );

    const ctx = testAgent({ lmcodeHomeDir: homeDir, homedir: join(selfDir, 'agents', 'main') });
    ctx.configure();
    try {
      const memoStore = ctx.agent.memoStore;
      expect(memoStore).toBeDefined();
      // Keep the real fastembed engine out of this test so it neither
      // downloads the model nor schedules background embeddings.
      memoStore!.setEmbeddingEngine({
        available: false,
        async embedBatch(): Promise<Float32Array[] | null> {
          return null;
        },
        cosineSimilarity(): number {
          return 0;
        },
      });

      const rendered = await ctx.agent.renderRecentSessions();

      expect(rendered).toContain('[project-past] Fix the build');
      expect(rendered).toContain('最后一句：「run the tests」');
      expect(rendered).not.toContain('This very session');
    } finally {
      // Release the agent's own connection before the temp dir is removed.
      await ctx.agent.memoStore?.close().catch(() => {});
    }
  });
});
