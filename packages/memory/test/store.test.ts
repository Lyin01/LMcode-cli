import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import { buildExitExtractionPrompt, parseMemoryMemos } from '../src/extractor.js';
import type { EmbeddingEngine } from '../src/embeddings.js';
import type { MemoryMemo } from '../src/models.js';

/**
 * Remove a temp dir, retrying on Windows where lingering SQLite WAL/SHM file
 * handles can briefly hold the directory locked (EBUSY/EPERM/ENOTEMPTY) even
 * after the store connection is closed.
 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

function makeMemo(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userNeed: 'Test requirement',
    approach: 'Test solution',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'compaction',
    sourceSessionId: 'test-session',
    sourceSessionTitle: 'Test Session',
    ...overrides,
  });
}

const fakeEmbeddingEngine: EmbeddingEngine = {
  available: true,
  async embedBatch(texts): Promise<Float32Array[]> {
    return texts.map((text) => {
      if (text.includes('closest')) return new Float32Array([1, 0]);
      if (text.includes('legacy')) return new Float32Array([0.8, 0.2]);
      return new Float32Array([0, 1]);
    });
  },
  cosineSimilarity(a, b): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
      dot += a[index]! * b[index]!;
      normA += a[index]! * a[index]!;
      normB += b[index]! * b[index]!;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dot / denominator;
  },
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('MemoryMemoStore', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lmcode-memory-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    // Close the SQLite connection so Windows releases the db/WAL/SHM file
    // handles before we delete the temp dir, avoiding EBUSY on unlink.
    await store.close();
    await removeTempDir(tmpDir);
  });

  describe('append / get', () => {
    it('appends and retrieves a memo', async () => {
      const memo = makeMemo();
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found).not.toBeUndefined();
      expect(found!.userNeed).toBe('Test requirement');
      expect(found!.sourceSessionId).toBe('test-session');
    });

    it('returns undefined for missing memo', async () => {
      expect(await store.get('nonexistent')).toBeUndefined();
    });

    it('stores and retrieves tags', async () => {
      const memo = makeMemo({ tags: ['react', 'auth', '部署'] });
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['react', 'auth', '部署']);
    });

    it('normalizes tags on storage', async () => {
      const memo = makeMemo({ tags: ['React', '  AUTH ', 'auth', '', 'toolongtagname'] });
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['react', 'auth', 'toolongtagname']);
    });

    it('updates tags and persists them', async () => {
      const memo = makeMemo({ tags: ['old'] });
      await store.append(memo);
      await store.update(memo.id, { tags: ['new', 'tag'] });
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['new', 'tag']);
    });

    it('updates a memo and reflects the change in search', async () => {
      const memo = makeMemo({ userNeed: 'original need' });
      await store.append(memo);

      const updated = await store.update(memo.id, { userNeed: 'updated need' });
      expect(updated).toBe(true);

      const found = await store.get(memo.id);
      expect(found!.userNeed).toBe('updated need');

      const result = await store.search('updated');
      expect(result.length).toBe(1);

      const oldResult = await store.search('original');
      expect(oldResult.length).toBe(0);
    });

    it('returns false when updating a missing memo', async () => {
      expect(await store.update('nonexistent', { userNeed: 'x' })).toBe(false);
    });
  });

  describe('init', () => {
    it('shares one initialization across concurrent first operations', async () => {
      const memo = makeMemo();

      const [, beforeAppend] = await Promise.all([
        store.init(),
        store.get(memo.id),
        store.list(),
      ]);
      expect(beforeAppend).toBeUndefined();

      await store.append(memo);
      await expect(store.get(memo.id)).resolves.toMatchObject({ id: memo.id });
    });

    it('throws when init fails and does not mark initialized', async () => {
      const badPath = join(tmpDir, 'existing-file');
      await writeFile(badPath, 'x', 'utf8');
      const badStore = new MemoryMemoStore(badPath);
      await expect(badStore.init()).rejects.toThrow();
      await expect(badStore.init()).rejects.toThrow();
      await badStore.close();
    });

    it('rejects operations when the SQLite file is corrupted', async () => {
      const corruptDir = join(tmpDir, 'corrupt', 'memory');
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, 'memos.sqlite'), 'not a sqlite database', 'utf8');
      const corruptStore = new MemoryMemoStore(join(tmpDir, 'corrupt'));

      await expect(corruptStore.init()).rejects.toThrow('Failed to initialize memory store');
      await expect(corruptStore.append(makeMemo())).rejects.toThrow(
        'Failed to initialize memory store',
      );
      await corruptStore.close();
    });

    it('adds legacy memo columns before creating indexes that depend on them', async () => {
      const legacyDir = join(tmpDir, 'legacy-schema', 'memory');
      await mkdir(legacyDir, { recursive: true });
      const db = new DatabaseSync(join(legacyDir, 'memos.sqlite'));
      db.exec(`
        CREATE TABLE memos (
          id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          source_session_title TEXT,
          user_need TEXT NOT NULL,
          approach TEXT NOT NULL,
          outcome TEXT NOT NULL,
          what_failed TEXT NOT NULL DEFAULT 'none',
          what_worked TEXT NOT NULL DEFAULT 'none',
          extraction_source TEXT NOT NULL,
          recorded_at INTEGER NOT NULL
        );
      `);
      db.close();

      const legacyStore = new MemoryMemoStore(join(tmpDir, 'legacy-schema'));
      const memo = makeMemo({ projectDir: '/workspace/legacy', tags: ['sqlite'] });
      try {
        await expect(legacyStore.init()).resolves.toBeUndefined();
        await legacyStore.append(memo);
        await expect(legacyStore.get(memo.id)).resolves.toMatchObject({
          projectDir: '/workspace/legacy',
          tags: ['sqlite'],
        });
      } finally {
        await legacyStore.close();
      }
    });
  });

  describe('embeddings', () => {
    it('persists vectors and returns project-scoped results by similarity', async () => {
      const closest = makeMemo({ userNeed: 'closest match', projectDir: '/workspace/a' });
      const excluded = makeMemo({ userNeed: 'closest other project', projectDir: '/workspace/b' });
      const legacy = makeMemo({ userNeed: 'legacy shared match', projectDir: '' });
      store.setEmbeddingEngine(fakeEmbeddingEngine);

      await store.append(closest);
      await store.append(excluded);
      await store.append(legacy);
      await store.flushEmbeddings();

      expect(store.hasEmbeddings()).toBe(true);
      const results = await store.searchByVector(new Float32Array([1, 0]), {
        projectDir: '/workspace/a',
      });
      expect(results.map((result) => result.memo.id)).toEqual([closest.id, legacy.id]);
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });

    it('applies vector recency cutoffs to the memo timestamp, not embedding creation time', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const old = makeMemo({
        userNeed: 'closest old experience',
        recordedAt: Date.now() - 120 * dayMs,
      });
      const recent = makeMemo({
        userNeed: 'legacy recent experience',
        recordedAt: Date.now() - 5 * dayMs,
      });
      store.setEmbeddingEngine(fakeEmbeddingEngine);
      await store.append(old);
      await store.append(recent);
      await store.flushEmbeddings();

      const all = await store.searchByVector(new Float32Array([1, 0]));
      expect(all.map(({ memo }) => memo.id)).toEqual([old.id, recent.id]);

      const recentOnly = await store.searchByVector(new Float32Array([1, 0]), {
        recencyCutoffDays: 90,
      });
      expect(recentOnly.map(({ memo }) => memo.id)).toEqual([recent.id]);
    });

    it('reports SQLite failures from an explicit embedding flush', async () => {
      store.setEmbeddingEngine(fakeEmbeddingEngine);
      await store.append(makeMemo({ userNeed: 'closest match' }));

      const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
      db.exec('DROP TABLE memory_embeddings');
      db.close();

      await expect(store.flushEmbeddings()).rejects.toThrow();
      await expect(store.close()).rejects.toThrow();
    });

    it('waits for an active embedding flush before closing the database', async () => {
      const started = createDeferred();
      const release = createDeferred();
      const engine: EmbeddingEngine = {
        available: true,
        async embedBatch(texts): Promise<Float32Array[]> {
          started.resolve();
          await release.promise;
          return texts.map(() => new Float32Array([1, 0]));
        },
        cosineSimilarity(a, b): number {
          return fakeEmbeddingEngine.cosineSimilarity(a, b);
        },
      };
      store.setEmbeddingEngine(engine);
      const runningMemo = makeMemo({ userNeed: 'close during flush' });
      const queuedMemo = makeMemo({ userNeed: 'queued before close' });
      await store.append(runningMemo);

      const flushing = store.flushEmbeddings();
      await started.promise;
      await store.append(queuedMemo);
      let closeSettled = false;
      const closing = store.close().finally(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      release.resolve();
      await Promise.all([flushing, closing]);

      const reopened = new MemoryMemoStore(tmpDir);
      reopened.setEmbeddingEngine(fakeEmbeddingEngine);
      await reopened.init();
      expect(reopened.hasEmbeddings()).toBe(true);
      const results = await reopened.searchByVector(new Float32Array([1, 0]));
      expect(new Set(results.map(({ memo }) => memo.id))).toEqual(
        new Set([runningMemo.id, queuedMemo.id]),
      );
      await reopened.close();
    });

    it('does not let an old in-flight vector overwrite an updated memo', async () => {
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const calls: string[][] = [];
      const engine: EmbeddingEngine = {
        available: true,
        async embedBatch(texts): Promise<Float32Array[]> {
          calls.push(texts);
          if (calls.length === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return texts.map((text) =>
            text.includes('updated content')
              ? new Float32Array([0, 1])
              : new Float32Array([1, 0]),
          );
        },
        cosineSimilarity(a, b): number {
          return fakeEmbeddingEngine.cosineSimilarity(a, b);
        },
      };
      store.setEmbeddingEngine(engine);
      const memo = makeMemo({ userNeed: 'original content' });
      await store.append(memo);

      const flushing = store.flushEmbeddings();
      await firstStarted.promise;
      await store.update(memo.id, { userNeed: 'updated content' });
      releaseFirst.resolve();
      await flushing;

      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toContain('original content');
      expect(calls[1]![0]).toContain('updated content');
      await expect(store.searchByVector(new Float32Array([1, 0]))).resolves.toEqual([]);
      const updatedResults = await store.searchByVector(new Float32Array([0, 1]));
      expect(updatedResults.map(({ memo: result }) => result.id)).toEqual([memo.id]);
    });

    it('requeues a failed batch so an explicit retry drains it without loss', async () => {
      let attempt = 0;
      const engine: EmbeddingEngine = {
        available: true,
        async embedBatch(texts): Promise<Float32Array[]> {
          attempt += 1;
          if (attempt === 1) throw new Error('temporary embedding failure');
          return texts.map(() => new Float32Array([1, 0]));
        },
        cosineSimilarity(a, b): number {
          return fakeEmbeddingEngine.cosineSimilarity(a, b);
        },
      };
      store.setEmbeddingEngine(engine);
      await store.append(makeMemo({ userNeed: 'retry this embedding' }));

      await expect(store.flushEmbeddings()).rejects.toThrow('temporary embedding failure');
      await expect(store.flushEmbeddings()).resolves.toBeUndefined();

      expect(attempt).toBe(2);
      expect(store.hasEmbeddings()).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a memo', async () => {
      const memo = makeMemo();
      await store.append(memo);
      expect(await store.delete(memo.id)).toBe(true);
      expect(await store.get(memo.id)).toBeUndefined();
    });

    it('handles delete of nonexistent id gracefully', async () => {
      // Delete on an empty store succeeds (nothing to remove)
      expect(await store.delete('no-such-id')).toBe(true);
    });
  });

  describe('list', () => {
    it('lists all memos sorted by recordedAt desc', async () => {
      const older = makeMemo({ recordedAt: 1000 });
      const newer = makeMemo({ recordedAt: 2000 });
      await store.append(older);
      await store.append(newer);

      const result = await store.list();
      expect(result.total).toBe(2);
      expect(result.memos[0]!.recordedAt).toBe(2000);
      expect(result.memos[1]!.recordedAt).toBe(1000);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeMemo());
      }
      const result = await store.list({ limit: 3 });
      expect(result.memos.length).toBe(3);
      expect(result.total).toBe(10);
    });

    it('filters by search keyword', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));
      await store.append(makeMemo({ userNeed: '配置 TypeScript', approach: '改 tsconfig' }));
      await store.append(makeMemo({ userNeed: '优化性能', approach: '加缓存' }));

      const result = await store.list({ search: 'oauth' });
      expect(result.total).toBe(1);
      expect(result.memos[0]!.userNeed).toContain('OAuth');
    });

    it('searches across approach field', async () => {
      await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));
      const result = await store.list({ search: 'redis' });
      expect(result.total).toBe(1);
    });
  });

  describe('read (iteration)', () => {
    it('yields all entries', async () => {
      await store.append(makeMemo());
      await store.append(makeMemo());

      const entries: MemoryMemo[] = [];
      for await (const memo of store.read()) {
        entries.push(memo);
      }
      expect(entries.length).toBe(2);
    });
  });

  describe('search', () => {
    it('recalls memos by keyword across fields', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证', approach: '加刷新逻辑' }));
      await store.append(makeMemo({ userNeed: '配置 TypeScript', approach: '改 tsconfig' }));

      const result = await store.search('oauth');
      expect(result.length).toBe(1);
      expect(result[0]!.userNeed).toContain('OAuth');
    });

    it('recalls mixed CJK/ASCII queries', async () => {
      await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));

      const result = await store.search('redis');
      expect(result.length).toBe(1);
      expect(result[0]!.approach).toContain('redis');
    });

    it('recalls individual CJK characters', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));

      const result = await store.search('认证');
      expect(result.length).toBe(1);
    });

    it('intersects multiple keywords', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证' }));
      await store.append(makeMemo({ userNeed: '修复 TypeScript 配置' }));

      const result = await store.search('修复 OAuth');
      expect(result.length).toBe(1);
      expect(result[0]!.userNeed).toContain('OAuth');
    });

    it('searches across tags', async () => {
      await store.append(makeMemo({ userNeed: 'fix bug', approach: 'change config', tags: ['redis'] }));
      const result = await store.list({ search: 'redis' });
      expect(result.total).toBe(1);
    });

    it('respects candidateLimit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeMemo({ userNeed: `task ${i} shared keyword` }));
      }

      const result = await store.search('shared keyword', { candidateLimit: 3 });
      expect(result.length).toBe(3);
    });

    it('returns an empty array for empty or whitespace queries', async () => {
      await store.append(makeMemo({ userNeed: 'something' }));

      expect(await store.search('')).toEqual([]);
      expect(await store.search('   ')).toEqual([]);
    });

    it('filters by projectDir and includes legacy empty projectDir', async () => {
      await store.append(
        makeMemo({ userNeed: 'project A need', projectDir: '/workspace/a', recordedAt: 1000 }),
      );
      await store.append(
        makeMemo({ userNeed: 'project B need', projectDir: '/workspace/b', recordedAt: 2000 }),
      );
      await store.append(makeMemo({ userNeed: 'legacy need', projectDir: '', recordedAt: 3000 }));

      const aResult = await store.search('need', { projectDir: '/workspace/a' });
      expect(aResult.map((m) => m.userNeed)).toEqual(['legacy need', 'project A need']);

      const bResult = await store.list({ search: 'need', projectDir: '/workspace/b' });
      expect(bResult.memos.map((m) => m.userNeed)).toEqual(['legacy need', 'project B need']);

      const all = [];
      for await (const memo of store.read({ projectDir: '/workspace/a' })) {
        all.push(memo);
      }
      expect(all.map((m) => m.userNeed)).toEqual(['legacy need', 'project A need']);
    });
  });
});

describe('migrateLegacyStores', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lmcode-memory-migration-test-'));
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('migrates per-session entries to the global store and deletes legacy files', async () => {
    const legacyMemo = createMemoryMemo({
      userNeed: 'Legacy need',
      approach: 'Legacy approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'legacy-session',
      sourceSessionTitle: 'Legacy Session',
    });

    const legacyDir = join(tmpDir, 'sessions', 'wd_abc123', 'memory');
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'entries.jsonl');
    await writeFile(
      legacyPath,
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacyMemo }),
      'utf8',
    );

    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    const globalStore = new MemoryMemoStore(tmpDir);
    const memos: MemoryMemo[] = [];
    for await (const memo of globalStore.read()) {
      memos.push(memo);
    }
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('Legacy need');

    await expect(stat(legacyPath)).rejects.toThrow();
    await globalStore.close();
  });

  it('skips entries whose ids already exist in the global store', async () => {
    const sharedMemo = createMemoryMemo({
      userNeed: 'Shared need',
      approach: 'Shared approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'shared-session',
      sourceSessionTitle: 'Shared Session',
    });

    const globalStore = new MemoryMemoStore(tmpDir);
    await globalStore.append(sharedMemo);

    const legacyDir = join(tmpDir, 'sessions', 'wd_shared', 'memory');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: sharedMemo }) + '\n',
      'utf8',
    );

    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    const memos: MemoryMemo[] = [];
    for await (const memo of globalStore.read()) {
      memos.push(memo);
    }
    expect(memos.length).toBe(1);
    await globalStore.close();
  });

  it('allows concurrent legacy migrations without duplicate rows or cleanup failures', async () => {
    const legacyMemo = createMemoryMemo({
      userNeed: 'Concurrent legacy need',
      approach: 'Concurrent legacy approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'concurrent-legacy-session',
      sourceSessionTitle: 'Concurrent Legacy Session',
    });
    const legacyDir = join(tmpDir, 'sessions', 'wd_concurrent', 'memory');
    const legacyPath = join(legacyDir, 'entries.jsonl');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacyMemo }),
      'utf8',
    );

    await expect(
      Promise.all([
        MemoryMemoStore.migrateLegacyStores(tmpDir),
        MemoryMemoStore.migrateLegacyStores(tmpDir),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const globalStore = new MemoryMemoStore(tmpDir);
    try {
      const memos: MemoryMemo[] = [];
      for await (const memo of globalStore.read()) memos.push(memo);
      expect(memos.map((memo) => memo.id)).toEqual([legacyMemo.id]);
      await expect(stat(legacyPath)).rejects.toThrow();
    } finally {
      await globalStore.close();
    }
  });
});

describe('parseMemoryMemos', () => {
  it('parses valid memory-memo blocks', () => {
    const text = `
## Current Focus
Working on auth module

\`\`\`memory-memo
{
  "userNeed": "修复 OAuth 401",
  "approach": "增加 token 刷新重试",
  "outcome": "完成",
  "whatFailed": "无限重试导致死循环，加了 max retries",
  "whatWorked": "加了 max retries 限制"
}
\`\`\`

\`\`\`memory-memo
{
  "userNeed": "优化编译速度",
  "approach": "升级 tsdown，启用并行编译",
  "outcome": "部分完成",
  "whatFailed": "none",
  "whatWorked": "none"
}
\`\`\`
`;

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(2);
    expect(memos[0]!.userNeed).toContain('OAuth');
    expect(memos[0]!.outcome).toBe('完成');
    expect(memos[1]!.outcome).toBe('部分完成');
  });

  it('returns empty for {"none": true}', () => {
    const text = '```memory-memo\n{"none": true}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips malformed JSON blocks', () => {
    const text = '```memory-memo\n{not valid json}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips blocks without userNeed', () => {
    const text = '```memory-memo\n{"approach": "something"}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('parses blocks with all new fields', () => {
    const text = '```memory-memo\n{"userNeed": "test", "approach": "x", "outcome": "完成", "whatFailed": "试了A不行", "whatWorked": "方案B成功"}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.whatFailed).toBe('试了A不行');
    expect(memos[0]!.whatWorked).toBe('方案B成功');
  });

  it('parses tags from memory-memo blocks', () => {
    const text = '```memory-memo\n{"userNeed": "fix auth", "approach": "x", "outcome": "完成", "tags": ["React", "auth"]}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.tags).toEqual(['react', 'auth']);
  });

  it('falls back to empty tags when tags field is missing', () => {
    const text = '```memory-memo\n{"userNeed": "test", "approach": "x", "outcome": "完成"}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.tags).toBeUndefined();
  });
});

describe('buildExitExtractionPrompt', () => {
  it('includes the sample text in the prompt (Chinese)', () => {
    const prompt = buildExitExtractionPrompt('sess-123', 50, '[user] fix the bug\n[assistant] done');
    expect(prompt).toContain('sess-123');
    expect(prompt).toContain('50');
    expect(prompt).toContain('[user] fix the bug');
    expect(prompt).toContain('[assistant] done');
    expect(prompt).toContain('已完成的任务闭环');
    expect(prompt).toContain('对话记录');
  });
});
