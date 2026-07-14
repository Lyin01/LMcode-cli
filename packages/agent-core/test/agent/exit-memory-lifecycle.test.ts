import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { GenerateResult } from '@lmcode-cli/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentOptions } from '../../src/agent';
import { testAgent } from './harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('exit memory extraction lifecycle', () => {
  it('aborts and settles extraction before closing the memo store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-memory-close-'));
    tempDirs.push(root);
    const response = deferred<GenerateResult>();
    const generateStarted = deferred<void>();
    let extractionSignal: AbortSignal | undefined;
    const generate: GenerateFn = (_provider, _system, _tools, _history, _callbacks, options) => {
      extractionSignal = options?.signal;
      generateStarted.resolve();
      return response.promise;
    };
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, 'first task', 'first result', 20);
    ctx.appendExchange(2, 'second task', 'second result', 40);
    const memoStore = ctx.agent.memoStore!;
    const appendMemo = vi.spyOn(memoStore, 'append');
    const closeMemoStore = vi.spyOn(memoStore, 'close');

    const extraction = ctx.agent.extractMemoriesOnExit();
    await generateStarted.promise;
    const closing = ctx.agent.close();

    await vi.waitFor(() => {
      expect(extractionSignal?.aborted).toBe(true);
    });
    expect(closeMemoStore).not.toHaveBeenCalled();

    response.resolve(textResult(
      '```memory-memo\n' +
        '{"userNeed":"late write","approach":"wait","outcome":"completed"}\n' +
        '```',
    ));
    await Promise.all([extraction, closing]);

    expect(appendMemo).not.toHaveBeenCalled();
    expect(closeMemoStore).toHaveBeenCalledTimes(1);
  });

  it('does not let a provider that ignores abort block agent close forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-memory-timeout-'));
    tempDirs.push(root);
    const response = deferred<GenerateResult>();
    const generateStarted = deferred<void>();
    let extractionSignal: AbortSignal | undefined;
    const generate: GenerateFn = (_provider, _system, _tools, _history, _callbacks, options) => {
      extractionSignal = options?.signal;
      generateStarted.resolve();
      return response.promise;
    };
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, 'first task', 'first result', 20);
    ctx.appendExchange(2, 'second task', 'second result', 40);
    const memoStore = ctx.agent.memoStore!;
    const appendMemo = vi.spyOn(memoStore, 'append');
    const closeMemoStore = vi.spyOn(memoStore, 'close');

    const extraction = ctx.agent.extractMemoriesOnExit();
    await generateStarted.promise;
    vi.useFakeTimers();
    const closing = ctx.agent.close();
    await vi.waitFor(() => expect(extractionSignal?.aborted).toBe(true));

    await vi.runAllTimersAsync();
    await closing;
    expect(closeMemoStore).toHaveBeenCalledTimes(1);

    response.resolve(textResult(
      '```memory-memo\n' +
        '{"userNeed":"late write","approach":"wait","outcome":"completed"}\n' +
        '```',
    ));
    await extraction;
    expect(appendMemo).not.toHaveBeenCalled();
  });
});

function textResult(text: string): GenerateResult {
  return {
    id: 'exit-memory-result',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

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
