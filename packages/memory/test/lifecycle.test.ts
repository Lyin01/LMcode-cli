/**
 * Regression tests for the store lifecycle hardening:
 * closed latch, read-path closing guard, prefix FTS fallback, exact total
 * past the candidate cap, embedding backfill/retry/model filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import type { EmbeddingEngine } from '../src/embeddings.js';
import type { MemoryMemo } from '../src/models.js';

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

function cosine(a: Float32Array, b: Float32Array): number {
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
}

function workingEngine(model = 'test-model'): EmbeddingEngine {
  return {
    available: true,
    model,
    async embedBatch(texts): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([1, 0]));
    },
    cosineSimilarity: cosine,
  };
}

describe('MemoryMemoStore lifecycle hardening', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lmcode-memory-lifecycle-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await store.close();
    await removeTempDir(tmpDir);
  });

  it('throws on any use after close instead of silently reopening', async () => {
    await store.append(makeMemo());
    await store.close();

    await expect(store.get('x')).rejects.toThrow('Memory store is closed');
    await expect(store.append(makeMemo())).rejects.toThrow('Memory store is closed');
    await expect(store.search('test')).rejects.toThrow('Memory store is closed');
    await expect(store.list()).rejects.toThrow('Memory store is closed');
    await expect(store.init()).rejects.toThrow('Memory store is closed');
  });

  it('keeps close() idempotent after completion', async () => {
    await store.append(makeMemo());
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('matches partial tokens via the prefix search path', async () => {
    const memo = makeMemo({ approach: 'Use the tokenization pipeline' });
    await store.append(memo);

    // Exact FTS match cannot hit: the index holds "tokenization", not "token".
    const exact = await store.search('token');
    expect(exact).toHaveLength(0);

    const prefixed = await store.search('token', { prefix: true });
    expect(prefixed.map((m) => m.id)).toContain(memo.id);

    // list() routes through the same prefix fallback.
    const listed = await store.list({ search: 'token' });
    expect(listed.memos.some((m) => m.id === memo.id)).toBe(true);
  });

  it('counts the exact total when FTS candidates hit the cap', async () => {
    await store.init();
    const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
    const insertMemo = db.prepare(
      `INSERT INTO memos (id, source_session_id, source_session_title, user_need, approach, outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rowidOf = db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const insertFts = db.prepare(
      'INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title) VALUES (?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (let i = 0; i < 210; i += 1) {
      const id = `bulk-${String(i)}`;
      insertMemo.run(
        id, 's', null, `commonword need ${String(i)}`, 'a', 'done',
        'none', 'none', 'manual', Date.now() - i, '', '[]',
      );
      const { rowid } = rowidOf.get(id) as { rowid: number };
      insertFts.run(rowid, 'commonword', '', '', '', '');
    }
    db.exec('COMMIT');
    db.close();

    const result = await store.list({ search: 'commonword' });
    // The FTS candidate pool caps at 200 — without the recount, total would
    // read 200 (or less) instead of the true 210.
    expect(result.total).toBe(210);
    expect(result.memos.length).toBe(50);
  });

  it('backfills embeddings for memos written before the engine was set', async () => {
    const memo = makeMemo({ userNeed: 'legacy note' });
    await store.append(memo); // no engine — nothing scheduled
    expect(store.hasEmbeddings()).toBe(false);

    store.setEmbeddingEngine(workingEngine());
    // The backfill runs in the background — give it a tick, then drain.
    await delay(20);
    await store.flushEmbeddings();

    expect(store.hasEmbeddings()).toBe(true);
    const results = await store.searchByVector(new Float32Array([1, 0]));
    expect(results.map((r) => r.memo.id)).toContain(memo.id);
  });

  it('re-queues jobs on transient null embeddings and drains on retry', async () => {
    const nullEngine: EmbeddingEngine = {
      available: true,
      model: 'test-model',
      async embedBatch(): Promise<Float32Array[] | null> {
        return null;
      },
      cosineSimilarity: cosine,
    };
    store.setEmbeddingEngine(nullEngine);
    await store.append(makeMemo());

    await store.flushEmbeddings();
    expect(store.hasEmbeddings()).toBe(false);

    // Engine recovers — the queued job must not have been dropped.
    store.setEmbeddingEngine(workingEngine());
    await store.flushEmbeddings();
    expect(store.hasEmbeddings()).toBe(true);
  });

  it('drops a job after repeated transient failures and stops calling the engine', async () => {
    let calls = 0;
    const nullEngine: EmbeddingEngine = {
      available: true,
      model: 'test-model',
      async embedBatch(): Promise<Float32Array[] | null> {
        calls += 1;
        return null;
      },
      cosineSimilarity: cosine,
    };
    store.setEmbeddingEngine(nullEngine);
    await store.append(makeMemo());

    // One embedBatch call per flush; after MAX_EMBEDDING_ATTEMPTS failures
    // the job is retired, so further flushes must not touch the engine.
    await store.flushEmbeddings();
    await store.flushEmbeddings();
    await store.flushEmbeddings();
    expect(calls).toBe(3);
    await store.flushEmbeddings();
    expect(calls).toBe(3);
    expect(store.hasEmbeddings()).toBe(false);
  });

  it('ignores stored vectors from a different embedding model', async () => {
    const memo = makeMemo({ userNeed: 'foreign vector' });
    await store.append(memo);

    const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
    db.prepare(
      'INSERT INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)',
    ).run(memo.id, JSON.stringify([1, 0]), 'old-model', Date.now());
    db.close();

    store.setEmbeddingEngine(workingEngine('new-model'));
    const results = await store.searchByVector(new Float32Array([1, 0]));
    expect(results).toHaveLength(0);
  });

  it('returns stored vectors from the current embedding model', async () => {
    const memo = makeMemo({ userNeed: 'current vector' });
    await store.append(memo);

    const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
    db.prepare(
      'INSERT INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)',
    ).run(memo.id, JSON.stringify([1, 0]), 'test-model', Date.now());
    db.close();

    store.setEmbeddingEngine(workingEngine('test-model'));
    const results = await store.searchByVector(new Float32Array([1, 0]));
    expect(results.map((r) => r.memo.id)).toContain(memo.id);
  });
});
