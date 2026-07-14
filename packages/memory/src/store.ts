import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'pathe';

import type { MemoryMemo, MemoryMemoListResult } from './models.js';
import { toSummary } from './models.js';
import { buildEmbeddingText, type EmbeddingEngine } from './embeddings.js';

const FILE_NAME = 'entries.jsonl';
const MIGRATION_MARKER = '.migrated';
const SQLITE_MIGRATION_MARKER = '.migrated-to-sqlite';

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;
type EmbeddingTimer = NodeJS.Timeout;

interface EmbeddingJob {
  readonly id: string;
  readonly text: string;
  state: 'queued' | 'running';
}

export class MemoryMemoStore {
  private readonly projectDir: string;
  private readonly jsonlPath: string;
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private writeLock: Promise<unknown> = Promise.resolve();
  private embeddingEngine: EmbeddingEngine | undefined;
  private readonly embeddingJobs = new Map<string, EmbeddingJob>();
  private embeddingTimer: EmbeddingTimer | undefined;
  private embeddingFlush: Promise<void> | undefined;
  private embeddingBackgroundError: unknown;
  private closing: Promise<void> | undefined;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.jsonlPath = join(projectDir, 'memory', FILE_NAME);
    this.dbPath = join(projectDir, 'memory', 'memos.sqlite');
  }

  /**
   * Open the SQLite database and run schema migrations. Call this once after
   * construction before relying on reads/writes.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization !== undefined) return this.initialization;

    const initialization = this.initialize();
    this.initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  private async initialize(): Promise<void> {
    await this.ensureDir();

    let dbSyncClass: DatabaseSyncConstructor;
    try {
      const sqliteModule = await import('node:sqlite');
      dbSyncClass = sqliteModule.DatabaseSync;
    } catch (error) {
      throw new Error('Memory storage requires node:sqlite support', { cause: error });
    }

    try {
      this.db = new dbSyncClass(this.dbPath);
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.createSchema();
      await this.migrateFromJsonl();
      this.initialized = true;
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        // Preserve the initialization failure below.
      }
      this.db = undefined;
      throw new Error(`Failed to initialize memory store at ${this.dbPath}`, { cause: error });
    }
  }

  /** Iterate all memos from the database, newest first. Optionally filter by project directory. */
  async *read(options?: { projectDir?: string }): AsyncIterable<MemoryMemo> {
    await this.init();
    if (this.db === undefined) return;
    const projectDir = options?.projectDir;
    const stmt =
      projectDir === undefined
        ? this.db.prepare('SELECT * FROM memos ORDER BY recorded_at DESC')
        : this.db.prepare(
            "SELECT * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC",
          );
    const rows = (
      projectDir === undefined ? stmt.all() : stmt.all(projectDir)
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      yield rowToMemo(row);
    }
  }

  /** Append a memo. */
  async append(entry: MemoryMemo): Promise<void> {
    return this.withWriteLock(() => this.appendInternal(entry));
  }

  /** Delete a memo by id. */
  async delete(id: string): Promise<boolean> {
    return this.withWriteLock(() => this.deleteInternal(id));
  }

  /** Get a single memo by ID. */
  async get(id: string): Promise<MemoryMemo | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const stmt = this.db.prepare('SELECT * FROM memos WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row !== undefined ? rowToMemo(row) : undefined;
  }

  /**
   * Full-text search over memos using the FTS5 index.
   *
   * Returns raw candidates newest first. Callers that need ranking should pass
   * the results to `rankMemos`. An empty or whitespace-only query returns an
   * empty array.
   */
  async search(
    query: string,
    options?: { candidateLimit?: number; projectDir?: string },
  ): Promise<MemoryMemo[]> {
    await this.init();
    if (this.db === undefined) return [];
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === undefined) return [];
    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const stmt =
      projectDir === undefined
        ? this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ?
         ORDER BY m.recorded_at DESC LIMIT ?`,
          )
        : this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ? AND (m.project_dir = ? OR m.project_dir = '')
         ORDER BY m.recorded_at DESC LIMIT ?`,
          );
    const rows = (
      projectDir === undefined ? stmt.all(ftsQuery, limit) : stmt.all(ftsQuery, projectDir, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToMemo);
  }

  /** List memos with optional full-text search and pagination. */
  async list(options?: {
    search?: string;
    limit?: number;
    offset?: number;
    projectDir?: string;
  }): Promise<MemoryMemoListResult> {
    await this.init();
    if (this.db === undefined) return { memos: [], total: 0 };

    const search = options?.search?.toLowerCase().trim();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const projectDir = options?.projectDir;

    if (search !== undefined && search.length > 0) {
      let candidates = await this.search(search, { projectDir });
      // Preserve the pre-SQLite behavior: keyword search is intersected with a
      // substring filter so the exact query string must appear somewhere in the
      // memo text.
      if (candidates.length === 0) {
        // Try prefix wildcard query so partial tokens still match.
        const prefixQuery = buildFtsQuery(search, { prefix: true });
        if (prefixQuery !== undefined) {
          candidates = await this.search(prefixQuery, { projectDir });
        }
      }
      if (candidates.length === 0) {
        // Fallback: scan recent memos so tags and wording not captured by the
        // FTS index are still considered.
        for await (const memo of this.read({ projectDir })) {
          candidates.push(memo);
        }
      }
      const filtered = candidates.filter((memo) => memoMatchesSearch(memo, search));
      const total = filtered.length;
      return { memos: filtered.slice(offset, offset + limit).map(toSummary), total };
    }

    const { rows, total } = this.listAll(limit, offset, projectDir);
    return { memos: rows.map(toSummary), total };
  }

  /**
   * One-time migration from per-workDir memory stores to a global store.
   * Reads `<lmcodeHomeDir>/sessions/<workDirKey>/memory/entries.jsonl`
   * and appends valid entries to the global SQLite store.
   * Deletes the legacy per-session memory files afterwards and writes a marker
   * file so the migration only runs once.
   */
  static async migrateLegacyStores(
    lmcodeHomeDir: string,
    existingTarget?: MemoryMemoStore,
  ): Promise<void> {
    const target = existingTarget ?? new MemoryMemoStore(lmcodeHomeDir);
    const ownsTarget = existingTarget === undefined;
    const markerPath = join(lmcodeHomeDir, 'memory', MIGRATION_MARKER);

    try {
      await stat(markerPath);
      return; // already migrated
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    try {
      const sessionsDir = join(lmcodeHomeDir, 'sessions');
      let sessionEntries: string[];
      try {
        sessionEntries = await readdir(sessionsDir, { withFileTypes: true })
          .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
        await target.init();
        await writeFile(markerPath, '', 'utf8');
        return;
      }

      const migratedIds = new Set<string>();
      for await (const memo of target.read()) {
        migratedIds.add(memo.id);
      }

      let migratedCount = 0;
      const legacyPaths: string[] = [];
      for (const sessionKey of sessionEntries) {
        const legacyPath = join(sessionsDir, sessionKey, 'memory', FILE_NAME);
        const didRead = await readJsonlLines(legacyPath, async (rawLine) => {
          const memo = target.parseLine(rawLine, 0);
          if (memo === undefined || migratedIds.has(memo.id)) return;
          try {
            await target.append(memo);
            migratedCount++;
          } catch (error) {
            // A concurrent migration may have inserted the same id after this
            // run built migratedIds. Only suppress the conflict when the row is
            // now durably visible; all other persistence failures still abort.
            if ((await target.get(memo.id)) === undefined) throw error;
          }
          migratedIds.add(memo.id);
        });
        if (didRead) legacyPaths.push(legacyPath);
      }

      // Delete sources only after every readable file has been fully persisted.
      for (const legacyPath of legacyPaths) {
        await unlink(legacyPath).catch((error: unknown) => {
          if (!isFileNotFound(error)) throw error;
        });
        await rmdir(dirname(legacyPath)).catch((error: unknown) => {
          if (!isDirectoryNotEmpty(error) && !isFileNotFound(error)) throw error;
        });
      }

      await writeFile(markerPath, `${migratedCount}\n`, 'utf8');
    } finally {
      // Close the temporary store's SQLite connection to avoid leaking a
      // DatabaseSync handle. On Windows, an unclosed connection keeps the
      // WAL/SHM files locked, causing EBUSY when the caller removes the
      // parent directory.
      if (ownsTarget) await target.close();
    }
  }

  /** @internal */
  parseLine(rawLine: string, _lineNumber: number): MemoryMemo | undefined {
    if (rawLine.length === 0) return undefined;
    try {
      const record = JSON.parse(rawLine) as Record<string, unknown>;
      if (record['type'] !== 'memory_memo' || !record['entry']) return undefined;
      const entry = record['entry'] as Record<string, unknown>;

      // Migrate v1 → v2 field names
      if (record['version'] === 1 || (entry['userRequirement'] !== undefined && entry['userNeed'] === undefined)) {
        const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
        return {
          id: str(entry['id']),
          sourceSessionId: str(entry['sourceSessionId']),
          sourceSessionTitle: str(entry['sourceSessionTitle'], undefined as unknown as string),
          userNeed: str(entry['userRequirement']),
          approach: str(entry['solution']),
          outcome: str(entry['completionStatus']),
          whatFailed: str(entry['problemsEncountered'], 'none'),
          whatWorked: 'none',
          extractionSource: entry['extractionSource'] === 'exit' ? 'exit' : 'compaction',
          recordedAt: typeof entry['recordedAt'] === 'number' ? entry['recordedAt'] : 0,
          projectDir: str(entry['projectDir']),
        };
      }

      return entry as unknown as MemoryMemo;
    } catch {
      // Skip corrupted lines
      return undefined;
    }
  }

  private createSchema(): void {
    if (this.db === undefined) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_session_title TEXT,
        user_need TEXT NOT NULL,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL,
        what_failed TEXT NOT NULL DEFAULT 'none',
        what_worked TEXT NOT NULL DEFAULT 'none',
        extraction_source TEXT NOT NULL CHECK(extraction_source IN ('compaction', 'exit', 'manual')),
        recorded_at INTEGER NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
        user_need,
        approach,
        what_failed,
        what_worked,
        source_session_title,
        content=''
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
        embedding_json TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);
    `);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    if (this.db === undefined) return;
    const info = this.db.prepare('PRAGMA table_info(memos)').all() as Array<{
      name: string;
    }>;
    const hasProjectDir = info.some((col) => col.name === 'project_dir');
    if (!hasProjectDir) {
      this.db.exec("ALTER TABLE memos ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
    }
    const hasTags = info.some((col) => col.name === 'tags');
    if (!hasTags) {
      this.db.exec("ALTER TABLE memos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    // Ensure indexes exist even for databases created before these indexes were added.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);
    `);
  }

  private async migrateFromJsonl(): Promise<void> {
    const markerPath = join(this.projectDir, 'memory', SQLITE_MIGRATION_MARKER);
    try {
      await stat(markerPath);
      return;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    const memos: MemoryMemo[] = [];
    const didRead = await readJsonlLines(this.jsonlPath, (rawLine) => {
      const memo = this.parseLine(rawLine, 0);
      if (memo !== undefined) memos.push(memo);
    });
    if (!didRead) {
      await writeFile(markerPath, '', 'utf8');
      return;
    }

    if (memos.length > 0) {
      this.insertMany(memos);
    }

    // Keep the legacy file as a backup; remove the old in-memory index.
    await archiveMigratedJsonl(this.jsonlPath);
    await unlink(join(this.projectDir, 'memory', 'index.json')).catch(() => {});
    await writeFile(markerPath, '', 'utf8');
  }

  private insertMany(memos: readonly MemoryMemo[]): void {
    if (this.db === undefined || memos.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const memo of memos) {
        const row = insert.get(
          memo.id,
          memo.sourceSessionId,
          memo.sourceSessionTitle ?? null,
          memo.userNeed,
          memo.approach,
          memo.outcome,
          memo.whatFailed,
          memo.whatWorked,
          memo.extractionSource,
          memo.recordedAt,
          memo.projectDir ?? '',
          JSON.stringify(memo.tags ?? []),
        ) as { rowid: number } | undefined;
        if (row === undefined) continue;
        insertFts.run(
          row.rowid,
          toFtsText(memo.userNeed),
          toFtsText(memo.approach),
          toFtsText(memo.whatFailed),
          toFtsText(memo.whatWorked),
          toFtsText(memo.sourceSessionTitle ?? ''),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`Failed to migrate memos to SQLite: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async appendInternal(entry: MemoryMemo): Promise<void> {
    await this.init();
    if (this.db === undefined) return;
    const insert = this.db.prepare(
      `INSERT INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      const row = insert.get(
        entry.id,
        entry.sourceSessionId,
        entry.sourceSessionTitle ?? null,
        entry.userNeed,
        entry.approach,
        entry.outcome,
        entry.whatFailed,
        entry.whatWorked,
        entry.extractionSource,
        entry.recordedAt,
        entry.projectDir ?? '',
        JSON.stringify(entry.tags ?? []),
      ) as { rowid: number };
      insertFts.run(
        row.rowid,
        toFtsText(entry.userNeed),
        toFtsText(entry.approach),
        toFtsText(entry.whatFailed),
        toFtsText(entry.whatWorked),
        toFtsText(entry.sourceSessionTitle ?? ''),
      );
      this.db.exec('COMMIT');
      this.scheduleEmbedding(entry);
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to append memo');
    }
  }

  /** Update a memo by id. Returns true if the memo existed and was updated. */
  async update(id: string, patch: Partial<Omit<MemoryMemo, 'id'>>): Promise<boolean> {
    return this.withWriteLock(() => this.updateInternal(id, patch));
  }

  /** @internal */
  private async updateInternal(
    id: string,
    patch: Partial<Omit<MemoryMemo, 'id'>>,
  ): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;

    const existing = await this.get(id);
    if (existing === undefined) return false;

    const updated: MemoryMemo = { ...existing, ...patch };
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const update = this.db.prepare(
      `UPDATE memos SET
        rowid = (SELECT COALESCE(MAX(rowid), 0) + 1 FROM memos),
        source_session_id = ?,
        source_session_title = ?,
        user_need = ?,
        approach = ?,
        outcome = ?,
        what_failed = ?,
        what_worked = ?,
        extraction_source = ?,
        recorded_at = ?,
        project_dir = ?,
        tags = ?
      WHERE id = ?
      RETURNING rowid`,
    );
    const updateFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      const oldRow = selectRow.get(id) as { rowid: number } | undefined;
      if (oldRow === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const row = update.get(
        updated.sourceSessionId,
        updated.sourceSessionTitle ?? null,
        updated.userNeed,
        updated.approach,
        updated.outcome,
        updated.whatFailed,
        updated.whatWorked,
        updated.extractionSource,
        updated.recordedAt,
        updated.projectDir ?? '',
        JSON.stringify(updated.tags ?? []),
        id,
      ) as { rowid: number } | undefined;
      if (row === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      deleteFts.run(oldRow.rowid);
      updateFts.run(
        row.rowid,
        toFtsText(updated.userNeed),
        toFtsText(updated.approach),
        toFtsText(updated.whatFailed),
        toFtsText(updated.whatWorked),
        toFtsText(updated.sourceSessionTitle ?? ''),
      );
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
      this.db.exec('COMMIT');
      this.scheduleEmbedding(updated);
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to update memo');
    }
  }

  private async deleteInternal(id: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const row = selectRow.get(id) as { rowid: number } | undefined;
    if (row === undefined) return true;
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    const deleteMemo = this.db.prepare('DELETE FROM memos WHERE id = ?');
    this.db.exec('BEGIN TRANSACTION');
    try {
      deleteFts.run(row.rowid);
      deleteMemo.run(id);
      this.db.exec('COMMIT');
      this.embeddingJobs.delete(id);
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to delete memo');
    }
  }

  /** Set the embedding engine. Call once after construction, before any writes. */
  setEmbeddingEngine(engine: EmbeddingEngine): void {
    this.embeddingEngine = engine;
  }

  /** Check whether the store has any vector embeddings. */
  hasEmbeddings(): boolean {
    if (this.db === undefined) return false;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get() as
      | { count: number }
      | undefined;
    return (row?.count ?? 0) > 0;
  }

  /** Access the embedding engine (may be undefined if not configured). */
  getEmbeddingEngine(): EmbeddingEngine | undefined {
    return this.embeddingEngine;
  }

  /**
   * Search memos by vector similarity. Returns memos sorted by cosine
   * similarity (highest first). Falls back to empty if no embeddings exist.
   *
   * Performance notes:
   * - candidateLimit bounds the SQL query so we never load every embedding.
   * - recencyCutoffDays lets callers ignore very old memos.
   * - projectDir is pushed into the SQL JOIN so unrelated projects are not
   *   considered at all.
   */
  async searchByVector(
    queryEmbedding: Float32Array,
    options?: {
      candidateLimit?: number;
      projectDir?: string;
      recencyCutoffDays?: number;
    },
  ): Promise<Array<{ memo: MemoryMemo; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];

    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const recencyCutoffDays = options?.recencyCutoffDays;
    const cutoffMs =
      recencyCutoffDays !== undefined && recencyCutoffDays > 0
        ? Date.now() - recencyCutoffDays * 24 * 60 * 60 * 1000
        : undefined;

    let rows: Array<{ memory_id: string; embedding_json: string }>;
    if (projectDir !== undefined) {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
              ORDER BY m.recorded_at DESC
              LIMIT ?
            `)
          : this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
                AND m.recorded_at > ?
              ORDER BY m.recorded_at DESC
              LIMIT ?
            `);
      rows = (cutoffMs === undefined
        ? stmt.all(projectDir, limit)
        : stmt.all(projectDir, cutoffMs, limit)) as Array<{
          memory_id: string;
          embedding_json: string;
        }>;
    } else {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              ORDER BY m.recorded_at DESC
              LIMIT ?
            `)
          : this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE m.recorded_at > ?
              ORDER BY m.recorded_at DESC
              LIMIT ?
            `);
      rows = (cutoffMs === undefined
        ? stmt.all(limit)
        : stmt.all(cutoffMs, limit)) as Array<{
          memory_id: string;
          embedding_json: string;
        }>;
    }

    if (rows.length === 0) return [];

    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.embedding_json) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length === 0 ||
          !parsed.every((value): value is number => typeof value === 'number' && Number.isFinite(value))
        ) {
          continue;
        }
        const vec = new Float32Array(parsed);
        const similarity = this.embeddingEngine?.cosineSimilarity(queryEmbedding, vec) ?? 0;
        if (similarity > 0) {
          scored.push({ id: row.memory_id, score: similarity });
        }
      } catch {
        // Skip corrupted embeddings
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topScored = scored.slice(0, limit);

    const results: Array<{ memo: MemoryMemo; score: number }> = [];
    for (const { id, score } of topScored) {
      const row = this.db
        .prepare('SELECT * FROM memos WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (row !== undefined) {
        results.push({ memo: rowToMemo(row), score });
      }
    }

    return results;
  }

  /**
   * Schedule async embedding generation for a memo. Debounced — the actual
   * batch flush runs after a short quiet period. Never blocks the caller.
   */
  scheduleEmbedding(memo: MemoryMemo): void {
    if (this.embeddingEngine === undefined || !this.embeddingEngine.available) return;
    this.embeddingJobs.set(memo.id, {
      id: memo.id,
      text: buildEmbeddingText(memo),
      state: 'queued',
    });
    if (this.closing !== undefined) return;
    if (this.embeddingTimer !== undefined) {
      clearTimeout(this.embeddingTimer);
    }
    // Debounce 2s — wait for a batch of writes to settle before flushing.
    this.embeddingTimer = setTimeout(() => {
      this.embeddingTimer = undefined;
      void this.flushEmbeddings().catch((error: unknown) => {
        // Keep the failure available for teardown diagnostics. Background
        // generation is optional, while explicit flushes still reject.
        this.embeddingBackgroundError = error;
      });
    }, 2000);
  }

  /** Flush all queued embeddings. Persistence failures are reported to the caller. */
  async flushEmbeddings(): Promise<void> {
    this.clearEmbeddingTimer();

    while (true) {
      let flush = this.embeddingFlush;
      if (flush === undefined) {
        const engine = this.embeddingEngine;
        if (engine === undefined || !engine.available || !this.hasQueuedEmbeddingJobs()) return;
        flush = this.startEmbeddingFlush(engine);
      }

      await flush;
      if (!this.hasQueuedEmbeddingJobs()) {
        this.embeddingBackgroundError = undefined;
        return;
      }
    }
  }

  private startEmbeddingFlush(engine: EmbeddingEngine): Promise<void> {
    const flush = this.drainEmbeddingJobs(engine);
    this.embeddingFlush = flush;
    void flush.then(
      () => {
        if (this.embeddingFlush === flush) this.embeddingFlush = undefined;
      },
      () => {
        if (this.embeddingFlush === flush) this.embeddingFlush = undefined;
      },
    );
    return flush;
  }

  private async drainEmbeddingJobs(engine: EmbeddingEngine): Promise<void> {
    while (engine.available && this.hasQueuedEmbeddingJobs()) {
      await this.flushEmbeddingBatch(engine);
    }
  }

  private async flushEmbeddingBatch(engine: EmbeddingEngine): Promise<void> {
    await this.init();
    const db = this.db;
    if (db === undefined) return;

    const jobs = [...this.embeddingJobs.values()].filter((job) => job.state === 'queued');
    if (jobs.length === 0) return;
    for (const job of jobs) job.state = 'running';

    try {
      await this.processEmbeddingJobs(engine, db, jobs);
    } catch (error) {
      this.requeueEmbeddingJobs(jobs);
      throw error;
    }
  }

  private async processEmbeddingJobs(
    engine: EmbeddingEngine,
    db: DatabaseSync,
    jobs: readonly EmbeddingJob[],
  ): Promise<void> {
    // Collect memos that still need embeddings.
    const pending: EmbeddingJob[] = [];
    for (const job of jobs) {
      if (this.embeddingJobs.get(job.id) !== job) continue;
      const row = db
        .prepare('SELECT memory_id FROM memory_embeddings WHERE memory_id = ?')
        .get(job.id);
      if (row !== undefined) {
        this.embeddingJobs.delete(job.id);
        continue;
      }

      const memo = this.getMemoFromDatabase(job.id, db);
      if (memo === undefined) {
        this.embeddingJobs.delete(job.id);
      } else if (buildEmbeddingText(memo) !== job.text) {
        this.scheduleEmbedding(memo);
      } else {
        pending.push(job);
      }
    }

    if (pending.length === 0) return;

    const vectors = await engine.embedBatch(pending.map((item) => item.text));
    if (vectors === null) {
      for (const job of pending) {
        if (this.embeddingJobs.get(job.id) === job) this.embeddingJobs.delete(job.id);
      }
      return;
    }
    if (vectors.length !== pending.length) {
      throw new Error(
        `Embedding engine returned ${vectors.length} vectors for ${pending.length} memos`,
      );
    }

    const insert = db.prepare(
      'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)',
    );
    const now = Date.now();
    const ready: Array<{ job: EmbeddingJob; vector: Float32Array }> = [];
    for (let index = 0; index < pending.length; index += 1) {
      const job = pending[index]!;
      if (this.embeddingJobs.get(job.id) !== job) continue;
      const memo = this.getMemoFromDatabase(job.id, db);
      if (memo === undefined) {
        this.embeddingJobs.delete(job.id);
      } else if (buildEmbeddingText(memo) !== job.text) {
        this.scheduleEmbedding(memo);
      } else {
        ready.push({ job, vector: vectors[index]! });
      }
    }
    if (ready.length === 0) return;

    db.exec('BEGIN TRANSACTION');
    try {
      for (const { job, vector } of ready) {
        insert.run(
          job.id,
          JSON.stringify([...vector]),
          'bge-small-zh-v1.5',
          now,
        );
      }
      db.exec('COMMIT');
      for (const { job } of ready) {
        if (this.embeddingJobs.get(job.id) === job) this.embeddingJobs.delete(job.id);
      }
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error('Failed to persist memory embeddings', { cause: error });
    }
  }

  private hasQueuedEmbeddingJobs(): boolean {
    for (const job of this.embeddingJobs.values()) {
      if (job.state === 'queued') return true;
    }
    return false;
  }

  private requeueEmbeddingJobs(jobs: readonly EmbeddingJob[]): void {
    for (const job of jobs) {
      if (this.embeddingJobs.get(job.id) === job) job.state = 'queued';
    }
  }

  private getMemoFromDatabase(id: string, db = this.db): MemoryMemo | undefined {
    if (db === undefined) return undefined;
    const row = db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToMemo(row);
  }

  private listAll(limit: number, offset: number, projectDir?: string): { rows: MemoryMemo[]; total: number } {
    if (this.db === undefined) return { rows: [], total: 0 };
    const countStmt =
      projectDir === undefined
        ? this.db.prepare('SELECT COUNT(*) as total FROM memos')
        : this.db.prepare("SELECT COUNT(*) as total FROM memos WHERE project_dir = ? OR project_dir = ''");
    const countRow = (
      projectDir === undefined ? countStmt.get() : countStmt.get(projectDir)
    ) as { total: number } | undefined;
    const total = countRow?.total ?? 0;
    const stmt =
      projectDir === undefined
        ? this.db.prepare('SELECT * FROM memos ORDER BY recorded_at DESC LIMIT ? OFFSET ?')
        : this.db.prepare(
            "SELECT * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC LIMIT ? OFFSET ?",
          );
    const rows = (
      projectDir === undefined ? stmt.all(limit, offset) : stmt.all(projectDir, limit, offset)
    ) as Array<Record<string, unknown>>;
    return { rows: rows.map(rowToMemo), total };
  }

  /**
   * Close the SQLite database connection and release all file handles.
   * Call this when the store is no longer needed (e.g., during session teardown)
   * to prevent EBUSY errors on Windows from lingering WAL/SHM files.
   *
   * After awaiting `close()` the store must not be used for further reads/writes
   * without calling `init()` again.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const closing = this.closeInternal();
    this.closing = closing;
    void closing.then(
      () => {
        if (this.closing === closing) this.closing = undefined;
      },
      () => {
        if (this.closing === closing) this.closing = undefined;
      },
    );
    return closing;
  }

  private async closeInternal(): Promise<void> {
    this.clearEmbeddingTimer();
    if (this.initialization !== undefined) {
      await this.initialization.catch(() => {
        // The initialization caller owns its failure; close still releases any handle.
      });
    }
    await this.writeLock.catch(() => {
      // A failed write has already rejected to its caller. It is still settled here.
    });

    let flushError: unknown;
    try {
      await this.flushEmbeddings();
    } catch (error) {
      flushError =
        this.embeddingBackgroundError !== undefined && this.embeddingBackgroundError !== error
          ? new AggregateError(
              [this.embeddingBackgroundError, error],
              'Failed to drain memory embeddings during close',
            )
          : error;
    }

    let closeError: unknown;
    if (this.db !== undefined) {
      try {
        // Checkpoint and switch to DELETE mode before closing so the WAL and
        // SHM files are cleaned up immediately rather than left on disk. On
        // Windows these auxiliary files lock the parent directory and cause
        // EBUSY errors during teardown.
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        this.db.exec('PRAGMA journal_mode = DELETE;');
      } catch {
        // Best-effort — the close below still releases the connection.
      }
      try {
        this.db.close();
      } catch (error) {
        closeError = error;
      } finally {
        this.db = undefined;
      }
    }
    this.initialized = false;

    if (flushError !== undefined && closeError !== undefined) {
      throw new AggregateError([flushError, closeError], 'Failed to close memory store');
    }
    if (flushError !== undefined) throw flushError;
    if (closeError !== undefined) throw closeError;
  }

  private clearEmbeddingTimer(): void {
    if (this.embeddingTimer === undefined) return;
    clearTimeout(this.embeddingTimer);
    this.embeddingTimer = undefined;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) {
      throw new Error('Memory store is closing');
    }
    const previous = this.writeLock;
    const next = previous.then(fn, fn);
    this.writeLock = next;
    return next;
  }
}

async function readJsonlLines(
  filePath: string,
  visit: (line: string) => void | Promise<void>,
): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += String(chunk);
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        await visit(pending.slice(0, newlineIndex).replace(/\r$/, ''));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
      }
    }
    if (pending.length > 0) {
      await visit(pending.replace(/\r$/, ''));
    }
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  } finally {
    stream.destroy();
  }
}

async function archiveMigratedJsonl(filePath: string): Promise<void> {
  const backupPath = `${filePath}.bak`;
  try {
    await rename(filePath, backupPath);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;

    // Another store can finish the same idempotent migration between our
    // JSONL read and rename. Accept that race only when its backup is present;
    // a missing source with no backup still signals data loss or I/O failure.
    try {
      await stat(backupPath);
    } catch (backupError) {
      if (isFileNotFound(backupError)) throw error;
      throw backupError;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EEXIST');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function rowToMemo(row: Record<string, unknown>): MemoryMemo {
  const sourceSessionTitle = row['source_session_title'];
  const projectDir = row['project_dir'];
  return {
    id: String(row['id']),
    sourceSessionId: String(row['source_session_id']),
    sourceSessionTitle: typeof sourceSessionTitle === 'string' ? sourceSessionTitle : undefined,
    userNeed: String(row['user_need']),
    approach: String(row['approach']),
    outcome: String(row['outcome']),
    whatFailed: String(row['what_failed']),
    whatWorked: String(row['what_worked']),
    extractionSource: row['extraction_source'] as 'compaction' | 'exit' | 'manual',
    recordedAt: Number(row['recorded_at']),
    projectDir: typeof projectDir === 'string' ? projectDir : '',
    tags: parseTags(row['tags']),
  };
}

function parseTags(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter((t): t is string => typeof t === 'string');
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
}

function memoMatchesSearch(memo: MemoryMemo, search: string): boolean {
  const haystack = [
    memo.userNeed,
    memo.approach,
    memo.whatFailed,
    memo.whatWorked,
    memo.sourceSessionTitle ?? '',
    ...(memo.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

/**
 * Tokenize text so FTS5's unicode61 tokenizer can index mixed CJK/ASCII text.
 * CJK characters are split into individual characters separated by spaces, and
 * CJK/ASCII boundaries are also separated so "使用redis缓存" becomes searchable
 * by "redis" as well as by individual CJK characters.
 */
function toFtsText(text: string): string {
  const lower = text.toLowerCase();
  const withBoundaries = lower
    .replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, '$1 $2')
    .replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, '$1 $2');
  const parts = withBoundaries.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.push(part);
    } else {
      // Split every CJK run into individual characters.
      for (const ch of part) {
        if (ch.length > 0) tokens.push(ch);
      }
    }
  }
  return tokens.join(' ');
}

function buildFtsQuery(search: string, options?: { prefix?: boolean }): string | undefined {
  const ftsText = toFtsText(search);
  const tokens = ftsText.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const suffix = options?.prefix ? '*' : '';
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"${suffix}`).join(' AND ');
}
