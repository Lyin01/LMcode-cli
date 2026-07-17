/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawnSync: mocks.spawnSync,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * The cache reads git state asynchronously (stale-while-revalidate). The
 * mocked execFile invokes its callback synchronously, but the cache applies
 * results in promise continuations — pump the microtask queue to settle.
 */
async function flushGitCallbacks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Route execFile calls: `git` reads succeed per-args, `gh pr view` errors. */
function mockGitExec(routes: {
  branch: string;
  status: string;
  diff: string;
  pr?: string | (() => never);
}): void {
  mocks.execFile.mockImplementation(
    (cmd: string, args: string[], _options: unknown, callback: ExecCallback) => {
      if (cmd === 'gh') {
        if (typeof routes.pr === 'function') routes.pr();
        if (typeof routes.pr === 'string') {
          callback(null, routes.pr, '');
          return;
        }
        callback(new Error('no pull request'), '', '');
        return;
      }
      if (args.includes('branch')) {
        callback(null, routes.branch, '');
        return;
      }
      if (args.includes('status')) {
        callback(null, routes.status, '');
        return;
      }
      if (args.includes('diff')) {
        callback(null, routes.diff, '');
        return;
      }
      callback(new Error(`unexpected git args: ${args.join(' ')}`), '', '');
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('git status cache', () => {
  it('caches branch and status reads until their TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('rev-parse')
        ? { status: 0, stdout: 'true\n' }
        : { status: 1, stdout: '' },
    );
    mockGitExec({
      branch: 'main\n',
      status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
      diff: '4\t1\tsrc/app.ts\n',
    });

    const cache = createGitStatusCache('/tmp/repo');

    // First call only kicks the background fetch — nothing is cached yet.
    expect(cache.getStatus()).toBeNull();
    await flushGitCallbacks();
    // Branch landed; this call kicks the status + PR refreshes.
    cache.getStatus();
    await flushGitCallbacks();

    const expected = {
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    };
    expect(cache.getStatus()).toEqual(expected);
    expect(cache.getStatus()).toEqual(expected);
    // execFile: branch + status + diff + gh pr view.
    expect(mocks.execFile).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    await flushGitCallbacks();
    // Branch TTL (5s) expired: +1 branch read.
    expect(mocks.execFile).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    await flushGitCallbacks();
    // Status TTL (15s) expired too: +1 branch, +1 status, +1 diff.
    expect(mocks.execFile).toHaveBeenCalledTimes(8);
    expect(cache.getStatus()).toEqual(expected);
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = vi.fn();
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('rev-parse')
        ? { status: 0, stdout: 'true\n' }
        : { status: 1, stdout: '' },
    );
    mockGitExec({
      branch: 'feature/footer\n',
      status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
      diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
      pr: '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n',
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    cache.getStatus();
    await flushGitCallbacks();
    cache.getStatus();
    await flushGitCallbacks();

    // Branch, status, and PR each changed once from their empty initial state.
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    const onChange = vi.fn();
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('rev-parse')
        ? { status: 0, stdout: 'true\n' }
        : { status: 1, stdout: '' },
    );
    mockGitExec({
      branch: 'main\n',
      status: '## main...origin/main\n M src/app.ts\n',
      diff: '2\t1\tsrc/app.ts\n',
      pr: () => {
        throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      },
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    cache.getStatus();
    await flushGitCallbacks();
    cache.getStatus();
    await flushGitCallbacks();

    // Branch and status changed; the throwing PR lookup resolves to null.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
  });

  it('returns null when the working directory is not a git repo and formats badges', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(createGitStatusCache('/tmp/not-a-repo').getStatus()).toBeNull();
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 1,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [± ↑1]');
  });
});
