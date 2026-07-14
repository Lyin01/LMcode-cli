import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, LmcodeError } from '../../src/errors';
import { createRPC } from '../../src/rpc';

interface CoreSide {
  getConfig(payload: { sessionId: string }): { model: string };
}

interface HostSide {
  emitEvent(event: { type: string; payload: { value: number } }): void;
  requestApproval(request: { requestId: string; toolName: string }): Promise<{ decision: string }>;
  fail(request: { code: string }): Promise<void>;
}

describe('createRPC', () => {
  it('routes request and response payloads across both sides', async () => {
    const [connectCore, connectHost] = createRPC<CoreSide, HostSide>();
    const hostImpl = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (request: { requestId: string; toolName: string }) => ({
        decision: `approved:${request.toolName}`,
      })),
      fail: vi.fn(async () => {}),
    };

    const hostProxyPromise = connectCore({
      getConfig: ({ sessionId }) => ({ model: `model-for:${sessionId}` }),
    });
    const coreProxy = await connectHost(hostImpl);
    const hostProxy = await hostProxyPromise;

    await hostProxy.emitEvent({ type: 'agent.status.updated', payload: { value: 1 } });
    await expect(
      hostProxy.requestApproval({ requestId: 'approval-1', toolName: 'Bash' }),
    ).resolves.toEqual({ decision: 'approved:Bash' });
    await expect(coreProxy.getConfig({ sessionId: 'session-1' })).resolves.toEqual({
      model: 'model-for:session-1',
    });
    expect(hostImpl.emitEvent).toHaveBeenCalledWith({
      type: 'agent.status.updated',
      payload: { value: 1 },
    });
  });

  it('binds prototype methods and rehydrates plain remote errors as LmcodeError(internal)', async () => {
    class HostImpl implements HostSide {
      readonly approvals: string[] = [];

      emitEvent(_event: { type: string; payload: { value: number } }): void {}

      async requestApproval(request: { requestId: string; toolName: string }) {
        this.approvals.push(request.requestId);
        return { decision: 'approved' };
      }

      async fail(request: { code: string }): Promise<void> {
        throw new Error(`host failed:${request.code}`);
      }
    }

    const hostImpl = new HostImpl();
    const [connectCore, connectHost] = createRPC<CoreSide, HostSide>();
    const hostProxyPromise = connectCore({
      getConfig: ({ sessionId }) => ({ model: sessionId }),
    });
    await connectHost(hostImpl);
    const hostProxy = await hostProxyPromise;

    await expect(
      hostProxy.requestApproval({ requestId: 'approval-2', toolName: 'Bash' }),
    ).resolves.toEqual({ decision: 'approved' });

    await expect(hostProxy.fail({ code: 'boom' })).rejects.toMatchObject({
      message: 'host failed:boom',
      code: ErrorCodes.INTERNAL,
    });
    await expect(hostProxy.fail({ code: 'boom' })).rejects.toBeInstanceOf(LmcodeError);
    expect(hostImpl.approvals).toEqual(['approval-2']);
  });

  it('passes a thrown LmcodeError across the wire preserving code and details', async () => {
    interface CallerSide {}
    interface RemoteSide {
      prompt(payload: { input: string }): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<CallerSide, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async prompt(payload) {
        if (payload.input === '') {
          throw new LmcodeError(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY, 'Prompt input cannot be empty', {
            details: { hint: 'pass at least one content part' },
            cause: new Error('local diagnostic — must not cross'),
          });
        }
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.prompt({ input: '' }).then(
      () => {
        throw new Error('expected prompt() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(LmcodeError);
    const error = received as LmcodeError;
    expect(error.code).toBe(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY);
    expect(error.message).toBe('Prompt input cannot be empty');
    expect(error.details).toEqual({ hint: 'pass at least one content part' });
    expect(error.cause).toBeUndefined();
  });

  it('serializes remote error details through JSON semantics before crossing the wire', async () => {
    interface RemoteSide {
      fail(payload: {}): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async fail() {
        const details: Record<string, unknown> = {
          nested: { ok: true },
          at: new Date('2026-05-18T00:00:00.000Z'),
          dropped: undefined,
          notFinite: Number.NaN,
          cause: new Error('detail failed'),
        };
        throw new LmcodeError(ErrorCodes.INTERNAL, 'Remote failed', {
          details,
        });
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.fail({}).then(
      () => {
        throw new Error('expected fail() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(LmcodeError);
    const error = received as LmcodeError;
    expect(error.details).toEqual({
      nested: { ok: true },
      at: '2026-05-18T00:00:00.000Z',
      notFinite: null,
      cause: {},
    });
  });

  it('rehydrates provider.* codes as LmcodeError', async () => {
    interface RemoteSide {
      callProvider(payload: { kind: string }): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async callProvider() {
        throw new LmcodeError(ErrorCodes.PROVIDER_RATE_LIMIT, 'Upstream rate limit', {
          details: { retryAfterMs: 1000 },
        });
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.callProvider({ kind: 'chat' }).then(
      () => {
        throw new Error('expected callProvider() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(LmcodeError);
    const error = received as LmcodeError;
    expect(error.code).toBe(ErrorCodes.PROVIDER_RATE_LIMIT);
    expect(error.details).toEqual({ retryAfterMs: 1000 });
  });

  it('collapses non-Error throws to LmcodeError(internal)', async () => {
    interface RemoteSide {
      misbehave(payload: {}): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async misbehave() {
        // oxlint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        throw 'not an error object';
      },
    });
    const remoteProxy = await remoteProxyPromise;

    await expect(remoteProxy.misbehave({})).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL,
      message: 'not an error object',
    });
    await expect(remoteProxy.misbehave({})).rejects.toBeInstanceOf(LmcodeError);
  });

  it('propagates an abort signal to the remote operation, not only its caller', async () => {
    interface RemoteSide {
      waitForAbort(
        payload: {},
        options?: { readonly signal?: AbortSignal },
      ): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    const started = deferred<void>();
    const remoteSettled = deferred<void>();
    let remoteSignal: AbortSignal | undefined;
    await connectRemote({
      async waitForAbort(_payload, options) {
        remoteSignal = options?.signal;
        started.resolve();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        remoteSettled.resolve();
      },
    });
    const remoteProxy = await remoteProxyPromise;
    const abortController = new AbortController();

    const call = remoteProxy.waitForAbort({}, { signal: abortController.signal });
    await started.promise;
    abortController.abort();

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await remoteSettled.promise;
    expect(remoteSignal?.aborted).toBe(true);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
