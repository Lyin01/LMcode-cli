//! Dream tracking — `/dream` cadence persistence.
//!
//! Mirrors the single-location variant of `packages/memory/src/dream.ts`:
//! state lives in `<lmcodeHomeDir>/dream-lock.json` and the reminder fires
//! when at least 24 hours AND 5 sessions have passed since the last dream.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::MemoryError;

pub const MIN_HOURS_BETWEEN_DREAMS: f64 = 24.0;
pub const MIN_SESSIONS_BETWEEN_DREAMS: u64 = 5;
const LOCK_FILE: &str = "dream-lock.json";

/// Persisted dream cadence state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamState {
    /// RFC 3339 timestamp of the last consolidation.
    pub last_dream_at: String,
    /// Sessions observed since the last consolidation.
    #[serde(default)]
    pub sessions_since_dream: u64,
}

/// Reads and writes the dream lock file.
#[derive(Debug)]
pub struct DreamTracker {
    lock_path: PathBuf,
    state: DreamState,
}

impl DreamTracker {
    /// Load (or initialize) the tracker rooted at `home` (`~/.lmcode`).
    pub fn load(home: &Path) -> Self {
        let lock_path = home.join(LOCK_FILE);
        let state = std::fs::read_to_string(&lock_path)
            .ok()
            .and_then(|text| serde_json::from_str::<DreamState>(&text).ok())
            .unwrap_or_else(|| DreamState {
                last_dream_at: now_iso(),
                sessions_since_dream: 0,
            });
        Self { lock_path, state }
    }

    pub fn state(&self) -> &DreamState {
        &self.state
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    /// Count one session (call on startup).
    pub fn record_session(&mut self) {
        self.state.sessions_since_dream += 1;
    }

    /// Reset after a completed consolidation.
    pub fn record_dream(&mut self) {
        self.state.last_dream_at = now_iso();
        self.state.sessions_since_dream = 0;
    }

    /// Whether the `/dream` reminder should be shown.
    pub fn should_suggest(&self) -> bool {
        hours_since(&self.state.last_dream_at) >= MIN_HOURS_BETWEEN_DREAMS
            && self.state.sessions_since_dream >= MIN_SESSIONS_BETWEEN_DREAMS
    }

    /// Persist the state (creating the parent directory when needed).
    pub fn save(&self) -> Result<(), MemoryError> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.state)
            .map_err(|error| MemoryError::Serialization(error.to_string()))?;
        std::fs::write(&self.lock_path, format!("{json}\n"))?;
        Ok(())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn hours_since(iso: &str) -> f64 {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return f64::INFINITY;
    };
    let elapsed = chrono::Utc::now().signed_duration_since(parsed.with_timezone(&chrono::Utc));
    elapsed.num_minutes() as f64 / 60.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_tracker_does_not_suggest() {
        let dir = tempfile::tempdir().unwrap();
        let tracker = DreamTracker::load(dir.path());
        assert!(!tracker.should_suggest(), "just created");
        assert_eq!(tracker.state().sessions_since_dream, 0);
    }

    #[test]
    fn suggests_after_enough_sessions_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut tracker = DreamTracker::load(dir.path());
        for _ in 0..MIN_SESSIONS_BETWEEN_DREAMS {
            tracker.record_session();
        }
        assert!(!tracker.should_suggest(), "time gate still closed");

        // Backdate the last dream by 25 hours.
        tracker.state.last_dream_at = (chrono::Utc::now() - chrono::Duration::hours(25))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(tracker.should_suggest());
    }

    #[test]
    fn record_dream_resets_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut tracker = DreamTracker::load(dir.path());
        for _ in 0..7 {
            tracker.record_session();
        }
        tracker.record_dream();
        tracker.save().unwrap();

        assert_eq!(tracker.state().sessions_since_dream, 0);
        assert!(!tracker.should_suggest());

        let reloaded = DreamTracker::load(dir.path());
        assert_eq!(reloaded.state().sessions_since_dream, 0);
        assert!(!reloaded.should_suggest());
    }

    #[test]
    fn session_counter_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut tracker = DreamTracker::load(dir.path());
        tracker.record_session();
        tracker.record_session();
        tracker.save().unwrap();
        let reloaded = DreamTracker::load(dir.path());
        assert_eq!(reloaded.state().sessions_since_dream, 2);
    }
}
