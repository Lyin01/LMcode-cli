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
  it('records successful extraction usage for the session without charging the active goal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-memory-usage-'));
    tempDirs.push(root);
    const generate: GenerateFn = async () =>
      textResult(
        '```memory-memo\n' +
          '{"userNeed":"remember task","approach":"extract","outcome":"completed"}\n' +
          '```',
      );
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, 'first task', 'first result', 20);
    ctx.appendExchange(2, 'second task', 'second result', 40);
    await ctx.agent.goal.createGoal({ objective: 'Continue the main task' });
    const appendMemo = vi.spyOn(ctx.agent.memoStore!, 'append').mockResolvedValue(undefined);

    try {
      await ctx.agent.extractMemoriesOnExit();

      expect(appendMemo).toHaveBeenCalledTimes(1);
      expect(ctx.agent.usage.stats().totalTokens).toBe(2);
      expect(ctx.agent.usage.data().currentTurn).toBeUndefined();
      expect(ctx.agent.goal.getGoal().goal?.tokensUsed).toBe(0);
    } finally {
      await ctx.agent.memoStore!.close();
    }
  });

  it('extracts messages appended while an earlier extraction was in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-memory-snapshot-'));
    tempDirs.push(root);
    const firstResponse = deferred<GenerateResult>();
    const firstGenerateStarted = deferred<void>();
    let calls = 0;
    const subsequentPrompts: string[] = [];
    const generate: GenerateFn = (_provider, _system, _tools, history) => {
      calls += 1;
      if (calls === 1) {
        firstGenerateStarted.resolve();
        return firstResponse.promise;
      }
      subsequentPrompts.push(
        history
          .flatMap((message) => message.content)
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n'),
      );
      return Promise.resolve(textResult('No new memory memo.'));
    };
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, 'first task', 'first result', 20);
    ctx.appendExchange(2, 'second task', 'second result', 40);

    try {
      const firstExtraction = ctx.agent.extractMemoriesOnExit();
      await firstGenerateStarted.promise;
      ctx.appendExchange(3, 'third task added during extraction', 'third result', 60);
      firstResponse.resolve(textResult('No memory memo from the first snapshot.'));
      await firstExtraction;

      await ctx.agent.extractMemoriesOnExit();

      expect(calls).toBe(2);
      expect(subsequentPrompts[0]).toContain('third task added during extraction');
      expect(subsequentPrompts[0]).toContain('third result');

      ctx.agent.context.clear();
      ctx.appendExchange(4, 'replacement task one', 'replacement result one', 20);
      ctx.appendExchange(5, 'replacement task two', 'replacement result two', 40);
      ctx.appendExchange(6, 'replacement task three', 'replacement result three', 60);
      await ctx.agent.extractMemoriesOnExit();

      expect(calls).toBe(3);
      expect(subsequentPrompts[1]).toContain('replacement task one');
      expect(subsequentPrompts[1]).not.toContain('third task added during extraction');
    } finally {
      await ctx.agent.memoStore!.close();
    }
  });

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
