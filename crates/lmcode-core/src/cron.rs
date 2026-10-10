//! Session cron: durable scheduled prompts, fired into the chat as
//! `<cron-fire>` envelopes (mirrors `tools/cron/*` + `agent/cron`).

use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use crate::cron_expr::CronExpression;

/// Recurring tasks older than this fire one final time with `stale: true`.
pub const STALE_THRESHOLD_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Persistent representation of a cron task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub cron: String,
    pub prompt: String,
    pub created_at: u64,
    /// Omitted/true = recurring (cron default); false = fire once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<u64>,
}

impl CronTask {
    pub fn is_recurring(&self) -> bool {
        self.recurring != Some(false)
    }

    /// Next fire after the last delivery, or after creation when it has never fired.
    pub fn next_fire_at_ms(&self) -> Option<i64> {
        let expression = CronExpression::parse(&self.cron).ok()?;
        let floor_ms = self.last_fired_at.unwrap_or(self.created_at);
        let floor = millis_to_local(floor_ms);
        expression
            .next_after(&floor)
            .map(|when| when.timestamp_millis())
    }

    /// Recurring tasks older than [`STALE_THRESHOLD_MS`] are stale.
    pub fn is_stale_at(&self, now_ms: u64) -> bool {
        self.is_recurring() && now_ms.saturating_sub(self.created_at) >= STALE_THRESHOLD_MS
    }
}

/// One due fire ready for injection.
#[derive(Debug, Clone)]
pub struct CronFire {
    pub task_id: String,
    pub cron: String,
    pub prompt: String,
    pub recurring: bool,
    pub stale: bool,
}

/// In-memory + on-disk cron task store.
#[derive(Debug, Default)]
pub struct CronStore {
    tasks: Vec<CronTask>,
    /// Directory for `<id>.json` mirrors (None = memory only).
    dir: Option<PathBuf>,
}

impl CronStore {
    pub fn with_dir(dir: PathBuf) -> Self {
        let mut store = Self {
            tasks: Vec::new(),
            dir: Some(dir),
        };
        store.load_from_disk();
        store
    }

    /// Rehydrate persisted tasks (mirrors `loadFromDisk`).
    pub fn load_from_disk(&mut self) {
        let Some(dir) = &self.dir else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path)
                && let Ok(task) = serde_json::from_str::<CronTask>(&text)
            {
                self.tasks.push(task);
            }
        }
        self.tasks.sort_by_key(|task| task.created_at);
    }

    pub fn list(&self) -> &[CronTask] {
        &self.tasks
    }

    /// Create a task (validates the expression first).
    pub fn add(&mut self, cron: &str, prompt: &str, recurring: bool) -> Result<CronTask, String> {
        CronExpression::parse(cron).map_err(|error| error.to_string())?;
        if prompt.trim().is_empty() {
            return Err("prompt must not be empty".to_string());
        }
        let task = CronTask {
            id: generate_task_id(),
            cron: cron.to_string(),
            prompt: prompt.to_string(),
            created_at: now_ms(),
            recurring: if recurring { None } else { Some(false) },
            last_fired_at: None,
        };
        persist_task(self.dir.as_deref(), &task);
        self.tasks.push(task.clone());
        Ok(task)
    }

    /// Remove a task by id; returns whether it existed.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.tasks.len();
        self.tasks.retain(|task| task.id != id);
        let removed = self.tasks.len() != before;
        if removed && let Some(dir) = &self.dir {
            let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
        }
        removed
    }

    /// Tasks whose next fire is due at `now` (mirrors the scheduler tick:
    /// one coalesced delivery per task, `lastFiredAt` floor, auto-delete
    /// for one-shots and for stale recurring tasks).
    pub fn due_fires(&mut self, now_ms: u64) -> Vec<CronFire> {
        let mut fires: Vec<CronFire> = Vec::new();
        let mut remove: Vec<String> = Vec::new();
        let mut updated: Vec<CronTask> = Vec::new();
        for task in &mut self.tasks {
            let Ok(expression) = CronExpression::parse(&task.cron) else {
                continue;
            };
            let floor = millis_to_local(task.last_fired_at.unwrap_or(task.created_at));
            let Some(next) = expression.next_after(&floor) else {
                continue;
            };
            let next_ms = next.timestamp_millis().max(0) as u64;
            if next_ms > now_ms {
                continue;
            }
            let recurring = task.is_recurring();
            let stale = recurring && now_ms.saturating_sub(task.created_at) >= STALE_THRESHOLD_MS;
            fires.push(CronFire {
                task_id: task.id.clone(),
                cron: task.cron.clone(),
                prompt: task.prompt.clone(),
                recurring,
                stale,
            });
            if recurring && !stale {
                // Advance the floor so the same fire is not re-delivered.
                task.last_fired_at = Some(now_ms);
                updated.push(task.clone());
            } else {
                // One-shots fire once; stale recurring tasks expire.
                remove.push(task.id.clone());
            }
        }
        for task in updated {
            persist_task(self.dir.as_deref(), &task);
        }
        for id in remove {
            self.remove(&id);
        }
        fires
    }
}

/// Render the chat-history injection text for a fired task (mirrors
/// `renderCronFireXml`).
pub fn render_cron_fire_xml(fire: &CronFire) -> String {
    let job_id = string_attr(&fire.task_id);
    let cron = string_attr(&fire.cron);
    format!(
        "<cron-fire jobId=\"{job_id}\" cron=\"{cron}\" recurring=\"{}\" coalescedCount=\"1\" stale=\"{}\">\n<prompt>\n{}\n</prompt>\n</cron-fire>",
        fire.recurring, fire.stale, fire.prompt
    )
}

fn string_attr(value: &str) -> String {
    let value = if value.is_empty() { "unknown" } else { value };
    value.replace('&', "&amp;").replace('"', "&quot;")
}

fn persist_task(dir: Option<&Path>, task: &CronTask) {
    let Some(dir) = dir else {
        return;
    };
    let _ = std::fs::create_dir_all(dir);
    if let Ok(text) = serde_json::to_string_pretty(task) {
        let _ = std::fs::write(dir.join(format!("{}.json", task.id)), text);
    }
}

fn millis_to_local(ms: u64) -> DateTime<Local> {
    DateTime::<Local>::from(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
}

fn generate_task_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed =
        nanos ^ (nanos >> 33) ^ ((std::process::id() as u128) << 17) ^ ((counter as u128) << 41);
    format!("{:08x}", (mixed & 0xffff_ffff) as u32)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmcode-cron-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn adds_lists_and_removes_tasks() {
        let dir = temp_dir("crud");
        let mut store = CronStore::with_dir(dir.join("cron"));
        assert!(store.add("bad expr", "p", true).is_err());
        assert!(store.add("*/5 * * * *", "  ", true).is_err());

        let task = store.add("*/5 * * * *", "check the build", true).unwrap();
        assert_eq!(task.id.len(), 8);
        assert!(task.is_recurring());
        assert_eq!(store.list().len(), 1);
        assert!(store.remove(&task.id));
        assert!(!store.remove(&task.id));
        assert!(store.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_and_reloads_tasks() {
        let dir = temp_dir("persist");
        let cron_dir = dir.join("cron");
        {
            let mut store = CronStore::with_dir(cron_dir.clone());
            store.add("3 9 * * 1-5", "weekday standup", true).unwrap();
            store.add("57 8 9 10 *", "one-shot", false).unwrap();
        }
        let reloaded = CronStore::with_dir(cron_dir);
        assert_eq!(reloaded.list().len(), 2);
        assert!(
            reloaded
                .list()
                .iter()
                .any(|task| task.prompt == "weekday standup")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn due_fires_respect_the_schedule() {
        let mut store = CronStore::default();
        // Every minute; created 10 minutes ago.
        let mut task = store.add("* * * * *", "tick", true).unwrap();
        task.created_at = now_ms() - 10 * 60_000;
        store.tasks[0] = task;

        let fires = store.due_fires(now_ms());
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].prompt, "tick");
        assert!(fires[0].recurring);
        assert!(!fires[0].stale);

        // The same minute does not fire twice (lastFiredAt advanced).
        let again = store.due_fires(now_ms());
        assert!(again.is_empty(), "no duplicate delivery");
    }

    #[test]
    fn one_shot_fires_once_then_auto_deletes() {
        let mut store = CronStore::default();
        let mut task = store.add("* * * * *", "remind", false).unwrap();
        task.created_at = now_ms() - 60_000;
        store.tasks[0] = task;
        assert!(!store.list()[0].is_recurring());

        let fires = store.due_fires(now_ms());
        assert_eq!(fires.len(), 1);
        assert!(!fires[0].recurring);
        assert!(store.list().is_empty(), "one-shot auto-deletes");
    }

    #[test]
    fn stale_recurring_tasks_fire_finally_and_expire() {
        let mut store = CronStore::default();
        let mut task = store.add("* * * * *", "old job", true).unwrap();
        task.created_at = now_ms() - STALE_THRESHOLD_MS - 60_000;
        store.tasks[0] = task;

        let fires = store.due_fires(now_ms());
        assert_eq!(fires.len(), 1);
        assert!(fires[0].stale);
        assert!(store.list().is_empty(), "stale tasks auto-expire");
    }

    #[test]
    fn renders_the_fire_envelope_with_escaped_attributes() {
        let fire = CronFire {
            task_id: "a&b".to_string(),
            cron: "* * * * *".to_string(),
            prompt: "keep <b>literal</b>".to_string(),
            recurring: true,
            stale: false,
        };
        let xml = render_cron_fire_xml(&fire);
        assert!(xml.starts_with("<cron-fire jobId=\"a&amp;b\""), "{xml}");
        assert!(xml.contains("recurring=\"true\""), "{xml}");
        assert!(xml.contains("coalescedCount=\"1\""), "{xml}");
        // The prompt body stays verbatim.
        assert!(xml.contains("keep <b>literal</b>"), "{xml}");
    }
}
