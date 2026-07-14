import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LmcodeHarness } from '../src/lmcode-harness';
import type { SDKRpcClient } from '../src/rpc';
import type { ResumedSessionSummary, SessionSummary } from '../src/types';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('LmcodeHarness lifecycle', () => {
  it('waits for a pending create and closes the late session', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_pending_create');
    const createResult = deferred<SessionSummary>();
    vi.spyOn(rpc, 'createSession').mockImplementation(() => createResult.promise);
    vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(undefined);
    const closeSession = vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);

    const creating = harness.createSession({ id: summary.id, workDir: summary.workDir });
    const closing = harness.close();
    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    createResult.resolve(summary);
    await expect(creating).rejects.toMatchObject({ code: 'session.closed' });
    await closing;

    expect(closeSession).toHaveBeenCalledWith({ sessionId: summary.id });
    expect(harness.sessions.size).toBe(0);
  });

  it('coalesces concurrent resumes for the same session id', async () => {
    const { harness, rpc, root } = await createHarness();
    const resumeResult = deferred<ResumedSessionSummary>();
    const resumeSession = vi.spyOn(rpc, 'resumeSession').mockImplementation(
      () => resumeResult.promise,
    );
    vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(undefined);
    vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);

    const first = harness.resumeSession({ id: ' ses_pending_resume ' });
    const second = harness.resumeSession({ id: 'ses_pending_resume' });
    expect(resumeSession).toHaveBeenCalledTimes(1);

    resumeResult.resolve(resumedSessionSummary(root, 'ses_pending_resume'));
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(firstSession).toBe(secondSession);
    expect(harness.sessions.get(firstSession.id)).toBe(firstSession);
    await harness.close();
  });

  it('rejects new session starts after close begins', async () => {
    const { harness } = await createHarness();
    await harness.close();

    await expect(
      harness.createSession({ id: 'ses_after_close', workDir: '/workspace' }),
    ).rejects.toMatchObject({ code: 'session.closed' });
  });
});

async function createHarness(): Promise<{
  readonly harness: LmcodeHarness;
  readonly rpc: SDKRpcClient;
  readonly root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'lmcode-sdk-harness-close-'));
  tempDirs.push(root);
  const harness = new LmcodeHarness({ homeDir: path.join(root, 'home') });
  const rpc = (harness as unknown as { readonly rpc: SDKRpcClient }).rpc;
  return { harness, rpc, root };
}

function sessionSummary(root: string, id: string): SessionSummary {
  return {
    id,
    workDir: path.join(root, 'work'),
    sessionDir: path.join(root, 'home', 'sessions', id),
    createdAt: 1,
    updatedAt: 1,
  };
}

function resumedSessionSummary(root: string, id: string): ResumedSessionSummary {
  return {
    ...sessionSummary(root, id),
    sessionMetadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: id,
      isCustomTitle: false,
      agents: {},
      custom: {},
    },
    agents: {},
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
