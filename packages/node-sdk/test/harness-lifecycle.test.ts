import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LmcodeHarness } from '../src/lmcode-harness';
import type { Event } from '../src/events';
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

  it('rejects duplicate creates while the same id is pending or active', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_duplicate_create');
    const createResult = deferred<SessionSummary>();
    const createSession = vi.spyOn(rpc, 'createSession').mockImplementation(
      () => createResult.promise,
    );
    vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(undefined);
    vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);

    const creating = harness.createSession({ id: summary.id, workDir: summary.workDir });
    await expect(
      harness.createSession({ id: summary.id, workDir: summary.workDir }),
    ).rejects.toMatchObject({ code: 'session.already_exists' });
    expect(createSession).toHaveBeenCalledTimes(1);

    createResult.resolve(summary);
    const session = await creating;
    await expect(
      harness.createSession({ id: summary.id, workDir: summary.workDir }),
    ).rejects.toMatchObject({ code: 'session.already_exists' });
    expect(createSession).toHaveBeenCalledTimes(1);

    await session.close({ extractMemories: false });
    await harness.close();
  });

  it('waits for a matching pending start before closeSession returns', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_close_pending_by_id');
    const createResult = deferred<SessionSummary>();
    vi.spyOn(rpc, 'createSession').mockImplementation(() => createResult.promise);
    vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(undefined);
    const closeSession = vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);

    const creating = harness.createSession({ id: summary.id, workDir: summary.workDir });
    const closing = harness.closeSession(summary.id);
    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    createResult.resolve(summary);
    const session = await creating;
    await closing;

    expect(closeSession).toHaveBeenCalledWith({ sessionId: summary.id });
    expect(harness.getSession(summary.id)).toBeUndefined();
    expect(() => session.getResumeState()).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
    await harness.close();
  });

  it('closes an active SDK handle before deleting its persisted session', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_delete_active');
    vi.spyOn(rpc, 'createSession').mockResolvedValue(summary);
    const extractMemoriesOnExit = vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(
      undefined,
    );
    const closeSession = vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);
    const deleteSession = vi.spyOn(rpc, 'deleteSession').mockResolvedValue(undefined);
    const session = await harness.createSession({ id: summary.id, workDir: summary.workDir });

    await harness.deleteSession(summary.id);

    expect(extractMemoriesOnExit).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith({ sessionId: summary.id });
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: summary.id });
    expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSession.mock.invocationCallOrder[0]!,
    );
    expect(harness.getSession(summary.id)).toBeUndefined();
    expect(() => session.getResumeState()).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
    await harness.close();
  });

  it('rejects new session starts after close begins', async () => {
    const { harness } = await createHarness();
    await harness.close();

    await expect(
      harness.createSession({ id: 'ses_after_close', workDir: '/workspace' }),
    ).rejects.toMatchObject({ code: 'session.closed' });
  });

  it('runs exit-time memory extraction for active sessions on close by default', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_close_extract_default');
    vi.spyOn(rpc, 'createSession').mockResolvedValue(summary);
    const extractMemoriesOnExit = vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(
      undefined,
    );
    vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);
    await harness.createSession({ id: summary.id, workDir: summary.workDir });

    await harness.close();

    expect(extractMemoriesOnExit).toHaveBeenCalled();
  });

  it('skips exit-time memory extraction when close opts out', async () => {
    const { harness, rpc, root } = await createHarness();
    const summary = sessionSummary(root, 'ses_close_extract_opt_out');
    vi.spyOn(rpc, 'createSession').mockResolvedValue(summary);
    const extractMemoriesOnExit = vi.spyOn(rpc, 'extractMemoriesOnExit').mockResolvedValue(
      undefined,
    );
    const closeSession = vi.spyOn(rpc, 'closeSession').mockResolvedValue(undefined);
    await harness.createSession({ id: summary.id, workDir: summary.workDir });

    await harness.close({ extractMemories: false });

    expect(extractMemoriesOnExit).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith({ sessionId: summary.id });
    expect(harness.sessions.size).toBe(0);
  });

  it('isolates event observers so one failing listener cannot starve the others', async () => {
    const { harness, rpc } = await createHarness();
    const event = {
      type: 'warning',
      sessionId: 'ses_listener_isolation',
      agentId: 'main',
      code: 'test.listener_failure',
      message: 'listener isolation probe',
    } as Event;
    const failing = vi.fn(() => {
      throw new Error('host listener failed');
    });
    const healthy = vi.fn();
    rpc.onEvent(failing);
    rpc.onEvent(healthy);

    expect(() => rpc.receiveEvent(event)).not.toThrow();

    expect(failing).toHaveBeenCalledWith(event);
    expect(healthy).toHaveBeenCalledWith(event);
    await harness.close({ extractMemories: false });
  });

  it('waits for every active session to close before reporting teardown failures', async () => {
    const { harness, rpc, root } = await createHarness();
    const slowClose = deferred<void>();
    vi.spyOn(rpc, 'createSession').mockImplementation(async (input) =>
      sessionSummary(root, input.id!),
    );
    const closeSession = vi.spyOn(rpc, 'closeSession').mockImplementation(async (input) => {
      if (input.sessionId === 'ses_close_failure') {
        throw new Error('close failed');
      }
      await slowClose.promise;
    });
    await harness.createSession({ id: 'ses_close_failure', workDir: root });
    await harness.createSession({ id: 'ses_close_slow', workDir: root });

    let settled = false;
    const result = harness.close({ extractMemories: false }).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    void result.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    slowClose.resolve();
    const outcome = await result;

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toBeInstanceOf(AggregateError);
    }
    expect(harness.sessions.size).toBe(0);
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
