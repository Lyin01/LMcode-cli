import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { GenerateResult } from '@lmcode-cli/liumir';
import {
  createMemoryMemo,
  toSummary,
  type MemoryMemo,
  type MemoryMemoStore,
} from '@lmcode/memory';
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

describe('exit pending resolution', () => {
  it('closes the pending memos the session finished while keeping the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-resolve-'));
    tempDirs.push(root);
    const prompts: string[] = [];
    let response = '';
    const generate: GenerateFn = (_provider, _system, _tools, history) => {
      prompts.push(
        history
          .flatMap((message) => message.content)
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n'),
      );
      return Promise.resolve(textResult(response));
    };
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, '继续修复 flaky test', '已修复并验证', 20);
    ctx.appendExchange(2, '继续修复 flaky test', '测试全绿，确认完成', 40);
    const store = ctx.agent.memoStore!;

    try {
      const finished = await seedPendingMemo(store, '修复 flaky test');
      const stillOpen = await seedPendingMemo(store, '升级 CI 缓存');
      // Simulate a bounded scan that offered only one of the two open memos:
      // an id outside the offered list must never become closable.
      const listSpy = vi
        .spyOn(store, 'list')
        .mockResolvedValue({ memos: [toSummary(finished)], total: 1 });
      response =
        '```memory-resolve\n' +
        `{"resolved": ["${finished.id}", "${stillOpen.id}", "memo-invented"]}\n` +
        '```\n\n' +
        '```memory-memo\n' +
        '{"userNeed": "修复 flaky test 的稳定性", "approach": "替换不稳断言", "outcome": "完成"}\n' +
        '```';
      const deleteSpy = vi.spyOn(store, 'delete');

      await ctx.agent.extractMemoriesOnExit();

      expect(prompts[0]).toContain(`- ${finished.id}｜修复 flaky test`);
      expect(prompts[0]).not.toContain(stillOpen.id);

      expect(await store.get(finished.id)).toBeUndefined();
      expect(await store.get(stillOpen.id)).not.toBeUndefined();
      // Only the offered id may resolve; the live-but-unoffered one and the
      // invented one must never reach a delete.
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(finished.id);

      listSpy.mockRestore();
      const listed = await store.list({});
      expect(listed.memos.some((memo) => memo.userNeed === '修复 flaky test 的稳定性')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('resolves pending memos even when the extraction adds no new memos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-resolve-only-'));
    tempDirs.push(root);
    let response = '';
    const generate: GenerateFn = () => Promise.resolve(textResult(response));
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, '继续修复 flaky test', '完成', 20);
    ctx.appendExchange(2, '继续修复 flaky test', '确认完成', 40);
    const store = ctx.agent.memoStore!;

    try {
      const finished = await seedPendingMemo(store, '修复 flaky test');
      response = '```memory-resolve\n' + `{"resolved": ["${finished.id}"]}\n` + '```';

      await ctx.agent.extractMemoriesOnExit();

      expect(await store.get(finished.id)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('never deletes a memo whose kind is no longer pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lmcode-exit-resolve-kind-'));
    tempDirs.push(root);
    let response = '';
    const generate: GenerateFn = () => Promise.resolve(textResult(response));
    const ctx = testAgent({
      generate,
      homedir: join(root, 'sessions', 'session-1', 'agents', 'main'),
      lmcodeHomeDir: root,
    });
    ctx.configure();
    ctx.appendExchange(1, '继续修复 flaky test', '完成', 20);
    ctx.appendExchange(2, '继续修复 flaky test', '确认完成', 40);
    const store = ctx.agent.memoStore!;

    try {
      const finished = await seedPendingMemo(store, '修复 flaky test');
      response = '```memory-resolve\n' + `{"resolved": ["${finished.id}"]}\n` + '```';
      const real = await store.get(finished.id);
      expect(real).toBeDefined();
      // Simulate the memo being reclassified between listing and deletion.
      const getSpy = vi.spyOn(store, 'get').mockResolvedValue({ ...real!, kind: 'preference' });
      const deleteSpy = vi.spyOn(store, 'delete');

      await ctx.agent.extractMemoriesOnExit();

      expect(deleteSpy).not.toHaveBeenCalled();
      getSpy.mockRestore();
      expect(await store.get(finished.id)).toBeDefined();
    } finally {
      await store.close();
    }
  });
});

async function seedPendingMemo(store: MemoryMemoStore, userNeed: string): Promise<MemoryMemo> {
  const memo = createMemoryMemo({
    sourceSessionId: 'seed-session',
    sourceSessionTitle: 'seed',
    userNeed,
    approach: 'progress so far',
    outcome: '未完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'exit',
    kind: 'pending',
  });
  await store.append(memo);
  return memo;
}

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
