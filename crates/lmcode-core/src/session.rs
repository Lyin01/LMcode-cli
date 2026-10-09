//! Session persistence — saves and restores conversations.
//!
//! The bucket scheme mirrors the TS store (`wd_<slug>_<hash12>/<session-id>`)
//! so sessions can be relocated later, but Rust-side data lives under
//! `~/.lmcode/rust-sessions/` while both implementations coexist — the two
//! stores never interfere with each other.

use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use lmcode_llm::message::{Message, Role};

use crate::error::CoreError;

const WORKDIR_KEY_PREFIX: &str = "wd_";
const HASH_LENGTH: usize = 12;
const MAX_SLUG_LENGTH: usize = 40;
const STATE_FILE: &str = "state.json";
const MESSAGES_FILE: &str = "messages.jsonl";
const TITLE_MAX_CHARS: usize = 60;

/// Root directory for Rust-side sessions.
pub fn sessions_root() -> PathBuf {
    crate::config::lmcode_home().join("rust-sessions")
}

/// Walk up from `work_dir` to the nearest project root (a directory holding
/// `.git` or `package.json`), mirroring `normalizeWorkDir` in the TS store.
pub fn normalize_workdir(work_dir: &Path) -> PathBuf {
    let resolved = std::path::absolute(work_dir).unwrap_or_else(|_| work_dir.to_path_buf());
    let mut dir: &Path = &resolved;
    loop {
        if dir.join(".git").exists() || dir.join("package.json").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => break,
        }
    }
    resolved
}

/// Encode a working directory into a stable bucket key: `wd_<slug>_<hash12>`.
pub fn encode_workdir_key(work_dir: &Path) -> String {
    let normalized = normalize_workdir(work_dir);
    let name = normalized
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let slug = slugify_workdir_name(&name);
    let mut hasher = Sha256::new();
    // Hash the forward-slash form so the key matches the TS encoding.
    hasher.update(normalized.to_string_lossy().replace('\\', "/").as_bytes());
    let digest = hasher.finalize();
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{WORKDIR_KEY_PREFIX}{slug}_{}", &hash[..HASH_LENGTH])
}

fn slugify_workdir_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut slug = String::new();
    let mut last_dash = false;
    for character in lower.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            slug.push(character);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug: String = slug.chars().take(MAX_SLUG_LENGTH).collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() || slug == "." || slug == ".." {
        "workspace".to_string()
    } else {
        slug
    }
}

/// Persisted session metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub id: String,
    #[serde(rename = "workDir")]
    pub work_dir: String,
    pub model: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// A loaded session: metadata + conversation history.
#[derive(Debug)]
pub struct Session {
    pub state: SessionState,
    pub messages: Vec<Message>,
    dir: PathBuf,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.state.id
    }

    /// Persist metadata and history to disk.
    pub fn save(&mut self, messages: &[Message]) -> Result<(), CoreError> {
        self.messages = messages.to_vec();
        self.state.updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        if self.state.title.is_none()
            && let Some(first_user) = messages.iter().find(|message| message.role == Role::User)
        {
            let text = first_user.text();
            if !text.trim().is_empty() {
                self.state.title = Some(text.chars().take(TITLE_MAX_CHARS).collect());
            }
        }

        let state_json = serde_json::to_string_pretty(&self.state).map_err(|error| {
            CoreError::Session(format!("failed to serialize session state: {error}"))
        })?;
        std::fs::write(self.dir.join(STATE_FILE), format!("{state_json}\n")).map_err(|error| {
            CoreError::Session(format!("failed to write session state: {error}"))
        })?;

        let mut buffer = String::new();
        for message in messages {
            let line = serde_json::to_string(message).map_err(|error| {
                CoreError::Session(format!("failed to serialize message: {error}"))
            })?;
            buffer.push_str(&line);
            buffer.push('\n');
        }
        std::fs::write(self.dir.join(MESSAGES_FILE), buffer).map_err(|error| {
            CoreError::Session(format!("failed to write session messages: {error}"))
        })?;
        Ok(())
    }
}

/// Reads and writes sessions under a root directory.
#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    /// Store rooted at `~/.lmcode/rust-sessions`.
    pub fn new() -> Self {
        Self {
            root: sessions_root(),
        }
    }

    /// Store rooted at an explicit directory (tests).
    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn bucket_dir(&self, work_dir: &Path) -> PathBuf {
        self.root.join(encode_workdir_key(work_dir))
    }

    /// Create a fresh session for `work_dir` and persist its state.
    pub fn create(&self, work_dir: &Path, model: &str) -> Result<Session, CoreError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let state = SessionState {
            id: format!("session_{}", uuid::Uuid::new_v4()),
            work_dir: work_dir.to_string_lossy().replace('\\', "/"),
            model: model.to_string(),
            title: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let dir = self.bucket_dir(work_dir).join(&state.id);
        std::fs::create_dir_all(&dir).map_err(|error| {
            CoreError::Session(format!("failed to create session dir: {error}"))
        })?;
        let mut session = Session {
            state,
            messages: Vec::new(),
            dir,
        };
        session.save(&[])?;
        Ok(session)
    }

    /// Load a session by id.
    pub fn load(&self, work_dir: &Path, id: &str) -> Result<Session, CoreError> {
        let dir = self.bucket_dir(work_dir).join(id);
        let state_path = dir.join(STATE_FILE);
        let state_text = std::fs::read_to_string(&state_path).map_err(|error| {
            CoreError::Session(format!(
                "session `{id}` not found at {}: {error}",
                state_path.display()
            ))
        })?;
        let state: SessionState = serde_json::from_str(&state_text).map_err(|error| {
            CoreError::Session(format!("session `{id}` state is invalid: {error}"))
        })?;
        let messages = read_messages(&dir)?;
        Ok(Session {
            state,
            messages,
            dir,
        })
    }

    /// The most recently updated session for `work_dir`, if any.
    pub fn latest(&self, work_dir: &Path) -> Result<Option<Session>, CoreError> {
        let Some(state) = self.list(work_dir)?.into_iter().next() else {
            return Ok(None);
        };
        self.load(work_dir, &state.id).map(Some)
    }

    /// All sessions for `work_dir`, most recently updated first.
    pub fn list(&self, work_dir: &Path) -> Result<Vec<SessionState>, CoreError> {
        let bucket = self.bucket_dir(work_dir);
        let entries = match std::fs::read_dir(&bucket) {
            Ok(entries) => entries,
            Err(_) => return Ok(Vec::new()),
        };
        let mut states = Vec::new();
        for entry in entries.flatten() {
            let state_path = entry.path().join(STATE_FILE);
            if let Ok(text) = std::fs::read_to_string(&state_path)
                && let Ok(state) = serde_json::from_str::<SessionState>(&text)
            {
                states.push(state);
            }
        }
        states.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(states)
    }
}

fn read_messages(dir: &Path) -> Result<Vec<Message>, CoreError> {
    let path = dir.join(MESSAGES_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(Vec::new()),
    };
    let mut messages = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Skip corrupted lines rather than failing the whole session load.
        if let Ok(message) = serde_json::from_str::<Message>(line) {
            messages.push(message);
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_ts_rules() {
        assert_eq!(slugify_workdir_name("lmcode"), "lmcode");
        assert_eq!(slugify_workdir_name("LMcode Desktop"), "lmcode-desktop");
        assert_eq!(slugify_workdir_name("a  b"), "a-b");
        assert_eq!(slugify_workdir_name("--x--"), "x");
        assert_eq!(slugify_workdir_name("."), "workspace");
        assert_eq!(slugify_workdir_name(".."), "workspace");
        assert_eq!(slugify_workdir_name(""), "workspace");
    }

    #[test]
    fn workdir_key_is_stable_and_bucketed() {
        let key = encode_workdir_key(Path::new("E:/lmcode-desktop-source"));
        assert!(key.starts_with("wd_lmcode-desktop-source_"), "got: {key}");
        assert_eq!(key.len(), "wd_lmcode-desktop-source_".len() + 12);
        assert_eq!(
            key,
            encode_workdir_key(Path::new("E:/lmcode-desktop-source"))
        );
    }

    #[test]
    fn saves_and_loads_a_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let work_dir = tempfile::tempdir().unwrap();
        let store = SessionStore::with_root(root.path());

        let mut session = store.create(work_dir.path(), "test/model").unwrap();
        let messages = vec![
            Message::user("hello world"),
            Message::assistant(vec![], vec![]),
        ];
        session.save(&messages).unwrap();

        let loaded = store.load(work_dir.path(), session.id()).unwrap();
        assert_eq!(loaded.state.model, "test/model");
        assert_eq!(loaded.state.title.as_deref(), Some("hello world"));
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[0].text(), "hello world");

        let listed = store.list(work_dir.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, session.id());

        let latest = store.latest(work_dir.path()).unwrap().unwrap();
        assert_eq!(latest.id(), session.id());
    }

    #[test]
    fn list_is_empty_for_unknown_workdir() {
        let root = tempfile::tempdir().unwrap();
        let work_dir = tempfile::tempdir().unwrap();
        let store = SessionStore::with_root(root.path());
        assert!(store.list(work_dir.path()).unwrap().is_empty());
        assert!(store.latest(work_dir.path()).unwrap().is_none());
    }
}
