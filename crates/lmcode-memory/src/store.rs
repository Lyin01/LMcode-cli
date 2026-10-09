//! SQLite-backed memo store.
//!
//! Uses the same database file and schema as the TypeScript implementation
//! (`~/.lmcode/memory/memos.sqlite`), so memos written by either side are
//! visible to the other. The FTS index is owned by the TS side; the Rust
//! reader scans all rows, so it never depends on the index being populated.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};

use crate::error::MemoryError;
use crate::memo::{MemoKind, MemoryMemo};

const SCHEMA_TABLES: &str = "
CREATE TABLE IF NOT EXISTS memos (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  source_session_title TEXT,
  user_need TEXT NOT NULL,
  approach TEXT NOT NULL,
  outcome TEXT NOT NULL,
  what_failed TEXT NOT NULL DEFAULT 'none',
  what_worked TEXT NOT NULL DEFAULT 'none',
  extraction_source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  project_dir TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'task'
);
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
  embedding_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5',
  created_at INTEGER NOT NULL
);
";

/// Indexes are created after the column migrations (they may reference
/// columns that older databases gain through `ALTER TABLE`).
const SCHEMA_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);
";

/// A handle to the memo database. Cheap to clone via `Arc`; all operations
/// take the internal lock.
pub struct MemoStore {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl MemoStore {
    /// Default database path: `$LMCODE_HOME/memory/memos.sqlite` or
    /// `~/.lmcode/memory/memos.sqlite`.
    pub fn default_path() -> PathBuf {
        let home = std::env::var("LMCODE_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".lmcode")
            });
        home.join("memory").join("memos.sqlite")
    }

    /// Open (creating if needed) the store at `path`.
    pub fn open(path: &Path) -> Result<Self, MemoryError> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        // Cascade embedding cleanup when memos are deleted.
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        let store = Self {
            conn: Mutex::new(connection),
            path: path.to_path_buf(),
        };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), MemoryError> {
        let connection = self.conn.lock().unwrap();
        // 1. Tables first (indexes may reference migrated columns).
        connection.execute_batch(SCHEMA_TABLES)?;
        // 2. Incremental columns shared with the TS implementation:
        //    databases created by older versions lack them (mirrors the TS
        //    migrations in `packages/memory/src/store.ts`).
        let existing = {
            let mut statement = connection.prepare("PRAGMA table_info(memos)")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<String>, _>>()?
        };
        let migrations: &[(&str, &str)] = &[
            (
                "project_dir",
                "ALTER TABLE memos ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''",
            ),
            (
                "tags",
                "ALTER TABLE memos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
            ),
            (
                "kind",
                "ALTER TABLE memos ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'",
            ),
        ];
        for (column, statement) in migrations {
            if !existing.iter().any(|name| name == column) {
                connection.execute_batch(statement)?;
            }
        }
        // 3. Indexes last.
        connection.execute_batch(SCHEMA_INDEXES)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Insert or replace a memo.
    pub fn append(&self, memo: &MemoryMemo) -> Result<(), MemoryError> {
        let tags_json = serde_json::to_string(&memo.tags)
            .map_err(|error| MemoryError::Serialization(error.to_string()))?;
        let connection = self.conn.lock().unwrap();
        connection.execute(
            "INSERT OR REPLACE INTO memos (
                id, source_session_id, source_session_title, user_need, approach,
                outcome, what_failed, what_worked, extraction_source, recorded_at,
                project_dir, tags, kind
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                memo.id,
                memo.source_session_id,
                memo.source_session_title,
                memo.user_need,
                memo.approach,
                memo.outcome,
                memo.what_failed,
                memo.what_worked,
                memo.extraction_source,
                memo.recorded_at,
                memo.project_dir,
                tags_json,
                memo.kind.as_str(),
            ],
        )?;
        Ok(())
    }

    /// All memos, newest first.
    pub fn all(&self) -> Result<Vec<MemoryMemo>, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id, source_session_id, source_session_title, user_need, approach,
                    outcome, what_failed, what_worked, extraction_source, recorded_at,
                    project_dir, tags, kind
             FROM memos ORDER BY recorded_at DESC",
        )?;
        let rows = statement.query_map([], row_to_memo)?;
        let mut memos = Vec::new();
        for row in rows {
            memos.push(row?);
        }
        Ok(memos)
    }

    /// Find one memo by id.
    pub fn find_by_id(&self, id: &str) -> Result<Option<MemoryMemo>, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id, source_session_id, source_session_title, user_need, approach,
                    outcome, what_failed, what_worked, extraction_source, recorded_at,
                    project_dir, tags, kind
             FROM memos WHERE id = ?1",
        )?;
        let mut rows = statement.query_map([id], row_to_memo)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Delete a memo; returns whether a row was removed.
    pub fn delete(&self, id: &str) -> Result<bool, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let removed = connection.execute("DELETE FROM memos WHERE id = ?1", [id])?;
        Ok(removed > 0)
    }

    /// Store (or replace) the embedding for a memo.
    pub fn upsert_embedding(
        &self,
        memo_id: &str,
        model: &str,
        vector: &[f32],
    ) -> Result<(), MemoryError> {
        let json = serde_json::to_string(vector)
            .map_err(|error| MemoryError::Serialization(error.to_string()))?;
        let now = crate::memo::now_millis();
        let connection = self.conn.lock().unwrap();
        connection.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding_json, model, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(memory_id) DO UPDATE SET
               embedding_json = excluded.embedding_json,
               model = excluded.model,
               created_at = excluded.created_at",
            params![memo_id, json, model, now],
        )?;
        Ok(())
    }

    /// All stored embeddings for `model`, keyed by memo id.
    pub fn load_embeddings(&self, model: &str) -> Result<HashMap<String, Vec<f32>>, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let mut statement = connection
            .prepare("SELECT memory_id, embedding_json FROM memory_embeddings WHERE model = ?1")?;
        let rows = statement.query_map([model], |row| {
            let id: String = row.get(0)?;
            let json: String = row.get(1)?;
            Ok((id, json))
        })?;
        let mut embeddings = HashMap::new();
        for row in rows {
            let (id, json) = row?;
            if let Ok(vector) = serde_json::from_str::<Vec<f32>>(&json) {
                embeddings.insert(id, vector);
            }
        }
        Ok(embeddings)
    }

    /// Memo ids with no embedding for `model` (backfill candidates).
    pub fn memos_missing_embeddings(&self, model: &str) -> Result<Vec<String>, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT m.id FROM memos m
             LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?1
             WHERE e.memory_id IS NULL",
        )?;
        let rows = statement.query_map([model], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    /// Total memo count.
    pub fn count(&self) -> Result<u64, MemoryError> {
        let connection = self.conn.lock().unwrap();
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))?;
        Ok(count as u64)
    }
}

fn row_to_memo(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryMemo> {
    let tags_json: String = row.get(11)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let kind: String = row.get(12)?;
    Ok(MemoryMemo {
        id: row.get(0)?,
        source_session_id: row.get(1)?,
        source_session_title: row.get(2)?,
        user_need: row.get(3)?,
        approach: row.get(4)?,
        outcome: row.get(5)?,
        what_failed: row.get(6)?,
        what_worked: row.get(7)?,
        extraction_source: row.get(8)?,
        recorded_at: row.get(9)?,
        project_dir: row.get(10)?,
        tags,
        kind: MemoKind::parse(&kind),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, MemoStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoStore::open(&dir.path().join("memos.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn round_trips_a_memo() {
        let (_dir, store) = store();
        let mut memo = MemoryMemo::new(
            "重构 Rust 工作区",
            "分批次移植",
            "完成",
            "session_1",
            "/proj",
            MemoKind::Task,
            vec!["rust".to_string(), "重构".to_string()],
        );
        memo.what_failed = "一次性大改".to_string();
        memo.what_worked = "按包分批".to_string();
        store.append(&memo).unwrap();

        let loaded = store.find_by_id(&memo.id).unwrap().unwrap();
        assert_eq!(loaded.user_need, "重构 Rust 工作区");
        assert_eq!(loaded.tags, vec!["rust", "重构"]);
        assert_eq!(loaded.kind, MemoKind::Task);
        assert_eq!(loaded.what_failed, "一次性大改");
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn append_is_idempotent_by_id_and_delete_works() {
        let (_dir, store) = store();
        let memo = MemoryMemo::new("a", "b", "c", "s", "/p", MemoKind::Task, vec![]);
        store.append(&memo).unwrap();
        store.append(&memo).unwrap();
        assert_eq!(store.count().unwrap(), 1);

        assert!(store.delete(&memo.id).unwrap());
        assert!(!store.delete(&memo.id).unwrap());
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn all_returns_newest_first() {
        let (_dir, store) = store();
        for (index, offset) in [1000i64, 3000, 2000].iter().enumerate() {
            let mut memo = MemoryMemo::new(
                format!("need {index}"),
                "a",
                "c",
                "s",
                "/p",
                MemoKind::Task,
                vec![],
            );
            memo.recorded_at = *offset;
            store.append(&memo).unwrap();
        }
        let all = store.all().unwrap();
        assert_eq!(all[0].user_need, "need 1");
        assert_eq!(all[2].user_need, "need 0");
    }

    #[test]
    fn schema_matches_the_ts_layout_for_interop() {
        // A row inserted with the exact TS column set must be readable.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memos.sqlite");
        let store = MemoStore::open(&path).unwrap();
        let connection = store.conn.lock().unwrap();
        connection
            .execute(
                "INSERT INTO memos (id, source_session_id, user_need, approach, outcome,
                    what_failed, what_worked, extraction_source, recorded_at, project_dir, tags, kind)
                 VALUES ('legacy-1', 'session_x', '旧记录', 'a', '完成', 'none', 'none', 'exit', 123, '', '[]', 'task')",
                [],
            )
            .unwrap();
        drop(connection);
        let loaded = store.find_by_id("legacy-1").unwrap().unwrap();
        assert_eq!(loaded.user_need, "旧记录");
        assert_eq!(loaded.source_session_title, None);
        assert!(loaded.tags.is_empty());
    }

    #[test]
    fn embeddings_round_trip_and_filter_by_model() {
        let (_dir, store) = store();
        let memo = MemoryMemo::new("a", "b", "c", "s", "/p", MemoKind::Task, vec![]);
        store.append(&memo).unwrap();
        store
            .upsert_embedding(&memo.id, "model-a", &[1.0, 2.0])
            .unwrap();

        let loaded = store.load_embeddings("model-a").unwrap();
        assert_eq!(loaded.get(&memo.id).unwrap(), &vec![1.0, 2.0]);
        assert!(
            store.load_embeddings("model-b").unwrap().is_empty(),
            "vectors from other models are never returned"
        );

        // One row per memo (TS schema): re-embedding replaces the vector.
        store.upsert_embedding(&memo.id, "model-b", &[3.0]).unwrap();
        assert!(store.load_embeddings("model-a").unwrap().is_empty());
        let other = store.load_embeddings("model-b").unwrap();
        assert_eq!(other.get(&memo.id).unwrap(), &vec![3.0]);
    }

    #[test]
    fn deleting_a_memo_cascades_to_its_embeddings() {
        let (_dir, store) = store();
        let memo = MemoryMemo::new("a", "b", "c", "s", "/p", MemoKind::Task, vec![]);
        store.append(&memo).unwrap();
        store.upsert_embedding(&memo.id, "m", &[1.0]).unwrap();
        store.delete(&memo.id).unwrap();
        assert!(
            store.load_embeddings("m").unwrap().is_empty(),
            "cascade delete must remove the embedding"
        );
    }

    #[test]
    fn missing_embedding_ids_are_reported_for_backfill() {
        let (_dir, store) = store();
        let with = MemoryMemo::new("a", "b", "c", "s", "/p", MemoKind::Task, vec![]);
        let without = MemoryMemo::new("d", "e", "f", "s", "/p", MemoKind::Task, vec![]);
        store.append(&with).unwrap();
        store.append(&without).unwrap();
        store.upsert_embedding(&with.id, "m", &[1.0]).unwrap();
        let missing = store.memos_missing_embeddings("m").unwrap();
        assert_eq!(missing, vec![without.id.clone()]);
    }

    #[test]
    fn migrates_databases_missing_newer_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        {
            // A database created before `project_dir` / `tags` / `kind`
            // existed (mirrors the older TS schema this must interoperate
            // with).
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE memos (
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
                    );",
                )
                .unwrap();
        }
        let store = MemoStore::open(&path).unwrap();
        let memo = MemoryMemo::new("a", "b", "c", "s", "/p", MemoKind::Task, vec![]);
        store.append(&memo).unwrap();
        let loaded = store.all().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].kind, MemoKind::Task);
        assert_eq!(loaded[0].project_dir, "/p");
    }
}
