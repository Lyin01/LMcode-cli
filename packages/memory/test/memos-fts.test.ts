import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
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

describe('SQLite-backed MemoryMemoStore FTS', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lmcode-memory-fts-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    // Close the SQLite connection so Windows releases the db/WAL/SHM file
    // handles before we delete the temp dir, avoiding EBUSY on unlink.
    await store.close();
    await removeTempDir(tmpDir);
  });

  it('indexes mixed CJK and ASCII so English words are searchable', async () => {
    await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));
    const result = await store.list({ search: 'redis' });
    expect(result.total).toBe(1);
  });

  it('indexes individual CJK characters', async () => {
    await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));
    const result = await store.list({ search: '认证' });
    expect(result.total).toBe(1);
  });

  it('intersects multiple query keywords', async () => {
    await store.append(makeMemo({ userNeed: '修复 OAuth 认证' }));
    await store.append(makeMemo({ userNeed: '修复 TypeScript 配置' }));

    const result = await store.list({ search: '修复 OAuth' });
    expect(result.total).toBe(1);
    expect(result.memos[0]?.userNeed).toContain('OAuth');
  });

  it('keeps the FTS index in sync after delete', async () => {
    const keep = makeMemo({ userNeed: '保留条目', approach: '保留' });
    const remove = makeMemo({ userNeed: '删除条目', approach: '删除' });
    await store.append(keep);
    await store.append(remove);

    await store.delete(remove.id);

    const result = await store.list({ search: '删除' });
    expect(result.total).toBe(0);
  });

  it('does not leak a deleted memo’s keywords into the next memo via rowid reuse', async () => {
    await store.append(makeMemo({ userNeed: 'normal entry' }));
    const ghost = makeMemo({ userNeed: 'zebra 即将删除' });
    await store.append(ghost); // holds MAX(rowid)

    await store.delete(ghost.id); // frees the max rowid
    await store.append(makeMemo({ userNeed: 'completely unrelated content' })); // reuses it

    // Raw search() returns FTS candidates without list()'s substring
    // re-filter — this is where stale index entries surface as ghosts.
    const ghosts = await store.search('zebra');
    expect(ghosts.length).toBe(0);
  });

  it('removes pre-update keywords so a later memo cannot inherit them', async () => {
    const a = makeMemo({ userNeed: 'krypton 更新前关键词' });
    const b = makeMemo({ userNeed: 'ordinary' });
    await store.append(a); // rowid 1
    await store.append(b); // rowid 2

    await store.update(a.id, { userNeed: '更新后的需求' }); // A moves to MAX(rowid), freeing rowid 1
    await store.delete(a.id);
    await store.delete(b.id);
    await store.append(makeMemo({ userNeed: '全新无关内容' })); // reuses rowid 1

    expect(await store.search('krypton')).toHaveLength(0);
    expect(await store.search('更新后')).toHaveLength(0);
  });

  it('migrates existing entries.jsonl into SQLite on first init', async () => {
    const legacy = createMemoryMemo({
      userNeed: 'Legacy need',
      approach: 'Legacy approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'legacy-session',
      sourceSessionTitle: 'Legacy Session',
    });

    const memoryDir = join(tmpDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacy }),
      'utf8',
    );

    const fresh = new MemoryMemoStore(tmpDir);
    const found = await fresh.get(legacy.id);
    expect(found).not.toBeUndefined();
    expect(found!.userNeed).toBe('Legacy need');

    const result = await fresh.list({ search: 'legacy' });
    expect(result.total).toBe(1);
    await fresh.close();
  });

  it('retries a partially persisted JSONL migration without duplicating FTS rows', async () => {
    const legacy = makeMemo({ userNeed: 'Retryable legacy migration' });
    const memoryDir = join(tmpDir, 'memory');
    const legacyPath = join(memoryDir, 'entries.jsonl');
    const backupPath = `${legacyPath}.bak`;
    await mkdir(backupPath, { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacy }),
      'utf8',
    );

    await expect(store.init()).rejects.toThrow('Failed to initialize memory store');
    await rm(backupPath, { recursive: true, force: true });

    await expect(store.init()).resolves.toBeUndefined();
    const result = await store.search('retryable legacy');
    expect(result.map((memo) => memo.id)).toEqual([legacy.id]);
    await expect(store.list()).resolves.toMatchObject({ total: 1 });
  });

  it('lets concurrent stores complete the same JSONL migration idempotently', async () => {
    const legacy = makeMemo({ userNeed: 'Concurrent legacy migration' });
    const memoryDir = join(tmpDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacy }),
      'utf8',
    );

    const first = new MemoryMemoStore(tmpDir);
    const second = new MemoryMemoStore(tmpDir);
    try {
      await expect(Promise.all([first.init(), second.init()])).resolves.toEqual([
        undefined,
        undefined,
      ]);

      const result = await first.search('concurrent legacy migration');
      expect(result.map((memo) => memo.id)).toEqual([legacy.id]);
      await expect(first.list()).resolves.toMatchObject({ total: 1 });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('handles concurrent appends without data loss', async () => {
    const a = makeMemo({ userNeed: '并发 A', recordedAt: 1000 });
    const b = makeMemo({ userNeed: '并发 B', recordedAt: 2000 });
    const c = makeMemo({ userNeed: '并发 C', recordedAt: 3000 });
    await Promise.all([store.append(a), store.append(b), store.append(c)]);

    const result = await store.list();
    expect(result.total).toBe(3);
    const needs = new Set(result.memos.map((m) => m.userNeed));
    expect(needs).toContain('并发 A');
    expect(needs).toContain('并发 B');
    expect(needs).toContain('并发 C');
  });

  it('creates the database file after first operation', async () => {
    await store.append(makeMemo());
    const dbPath = join(tmpDir, 'memory', 'memos.sqlite');
    await expect(
      import('node:fs/promises').then((fs) => fs.stat(dbPath)),
    ).resolves.toBeDefined();
  });
});
