import { describe, expect, it, vi } from 'vitest';

import type { SDKRpcClient } from '../src/rpc';
import { Session } from '../src/session';

describe('Session.close', () => {
  it('clears the memory extraction deadline after extraction finishes', async () => {
    vi.useFakeTimers();
    try {
      const extractMemoriesOnExit = vi.fn(async () => {});
      const closeSession = vi.fn(async () => {});
      const session = new Session({
        id: 'session-close-timer',
        workDir: '/workspace',
        rpc: {
          extractMemoriesOnExit,
          closeSession,
          clearSessionHandlers: vi.fn(),
        } as unknown as SDKRpcClient,
      });

      await session.close();

      expect(extractMemoriesOnExit).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts memory extraction when its close deadline expires', async () => {
    vi.useFakeTimers();
    try {
      let extractionSignal: AbortSignal | undefined;
      const extractMemoriesOnExit = vi.fn(
        async (
          _input: { readonly sessionId: string },
          options?: { readonly signal?: AbortSignal },
        ) => {
          extractionSignal = options?.signal;
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                reject(options.signal?.reason);
              },
              { once: true },
            );
          });
        },
      );
      const closeSession = vi.fn(async () => {});
      const session = new Session({
        id: 'session-close-extraction-timeout',
        workDir: '/workspace',
        rpc: {
          extractMemoriesOnExit,
          closeSession,
          clearSessionHandlers: vi.fn(),
        } as unknown as SDKRpcClient,
      });

      const closing = session.close();
      expect(extractionSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await closing;

      expect(extractionSignal?.aborted).toBe(true);
      expect(extractMemoriesOnExit).toHaveBeenCalledWith(
        { sessionId: session.id },
        { signal: extractionSignal },
      );
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues closing after aborting an extraction transport that does not settle', async () => {
    vi.useFakeTimers();
    try {
      let extractionSignal: AbortSignal | undefined;
      const extractMemoriesOnExit = vi.fn(
        async (
          _input: { readonly sessionId: string },
          options?: { readonly signal?: AbortSignal },
        ) => {
          extractionSignal = options?.signal;
          await new Promise<void>(() => {});
        },
      );
      const closeSession = vi.fn(async () => {});
      const session = new Session({
        id: 'session-close-stuck-extraction',
        workDir: '/workspace',
        rpc: {
          extractMemoriesOnExit,
          closeSession,
          clearSessionHandlers: vi.fn(),
        } as unknown as SDKRpcClient,
      });

      const closing = session.close();
      await vi.advanceTimersByTimeAsync(30_000);
      await closing;

      expect(extractionSignal?.aborted).toBe(true);
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent close calls into one RPC lifecycle', async () => {
    let finishCloseSession!: () => void;
    const closeSessionRpc = new Promise<void>((resolve) => {
      finishCloseSession = resolve;
    });
    const extractMemoriesOnExit = vi.fn(async () => {});
    const closeSession = vi.fn(() => closeSessionRpc);
    const session = new Session({
      id: 'session-close-concurrent',
      workDir: '/workspace',
      rpc: {
        extractMemoriesOnExit,
        closeSession,
        clearSessionHandlers: vi.fn(),
      } as unknown as SDKRpcClient,
    });

    const first = session.close();
    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledTimes(1);
    });

    // closeInternal marks the session closed before the RPC finishes. A
    // concurrent caller must still join the in-flight close instead of
    // resolving early at that point.
    const second = session.close();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishCloseSession();
    await Promise.all([first, second]);

    expect(extractMemoriesOnExit).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
