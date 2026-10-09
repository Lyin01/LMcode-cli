//! Memory memo model — mirrors `packages/memory/src/models.ts`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Three kinds of long-term memory: a completed *task experience*, a stable
/// *user preference/habit*, or a *pending task* to be resumed later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoKind {
    Task,
    Preference,
    Pending,
}

impl MemoKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Preference => "preference",
            Self::Pending => "pending",
        }
    }

    /// Normalize an untrusted kind: only known kinds survive, anything else
    /// is treated as a task memo.
    pub fn parse(value: &str) -> Self {
        match value {
            "preference" => Self::Preference,
            "pending" => Self::Pending,
            _ => Self::Task,
        }
    }
}

/// A structured task-experience record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMemo {
    pub id: String,
    pub source_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_title: Option<String>,
    pub user_need: String,
    pub approach: String,
    pub outcome: String,
    pub what_failed: String,
    pub what_worked: String,
    /// `compaction` | `exit` | `manual`.
    pub extraction_source: String,
    /// Epoch milliseconds when this entry was created.
    pub recorded_at: i64,
    pub project_dir: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub kind: MemoKind,
}

impl MemoryMemo {
    /// Create a memo with defaults (`whatFailed`/`whatWorked` = `none`,
    /// extraction source `manual`); callers override fields afterwards.
    pub fn new(
        user_need: impl Into<String>,
        approach: impl Into<String>,
        outcome: impl Into<String>,
        source_session_id: impl Into<String>,
        project_dir: impl Into<String>,
        kind: MemoKind,
        tags: Vec<String>,
    ) -> Self {
        Self {
            id: generate_id(),
            source_session_id: source_session_id.into(),
            source_session_title: None,
            user_need: user_need.into(),
            approach: approach.into(),
            outcome: outcome.into(),
            what_failed: "none".to_string(),
            what_worked: "none".to_string(),
            extraction_source: "manual".to_string(),
            recorded_at: now_millis(),
            project_dir: project_dir.into(),
            tags,
            kind,
        }
    }
}

/// Current time in epoch milliseconds.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `memo-<millis base36>-<random 6>` — mirrors the TS id shape.
fn generate_id() -> String {
    let millis = now_millis().max(0) as u64;
    let mut value = millis;
    let mut base36 = String::new();
    if value == 0 {
        base36.push('0');
    }
    while value > 0 {
        let digit = (value % 36) as u8;
        base36.push(
            (if digit < 10 {
                b'0' + digit
            } else {
                b'a' + digit - 10
            }) as char,
        );
        value /= 36;
    }
    let random: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    format!("memo-{}-{random}", base36.chars().rev().collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kinds_defensively() {
        assert_eq!(MemoKind::parse("preference"), MemoKind::Preference);
        assert_eq!(MemoKind::parse("pending"), MemoKind::Pending);
        assert_eq!(MemoKind::parse("task"), MemoKind::Task);
        assert_eq!(MemoKind::parse("nonsense"), MemoKind::Task);
        assert_eq!(MemoKind::parse(""), MemoKind::Task);
    }

    #[test]
    fn generates_unique_ids_with_expected_shape() {
        let a = generate_id();
        let b = generate_id();
        assert!(a.starts_with("memo-"), "got: {a}");
        assert_ne!(a, b);
        assert_eq!(a.matches('-').count(), 2);
    }

    #[test]
    fn memo_serializes_to_camel_case() {
        let memo = MemoryMemo::new(
            "need",
            "approach",
            "done",
            "s1",
            "/p",
            MemoKind::Task,
            vec![],
        );
        let json = serde_json::to_value(&memo).unwrap();
        assert!(json.get("userNeed").is_some());
        assert!(json.get("sourceSessionId").is_some());
        assert!(json.get("recordedAt").is_some());
    }
}
