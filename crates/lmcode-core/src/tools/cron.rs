//! Cron tools: `CronCreate` / `CronDelete` / `CronList`
//! (mirrors `tools/cron/cron-*.ts`).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::cron::CronStore;

use super::Tool;

/// Shared cron store, injected into both the tools and the agent.
pub type CronHandle = Arc<Mutex<CronStore>>;

/// Schedule a prompt to be enqueued at a future time.
pub struct CronCreateTool {
    store: CronHandle,
}

impl CronCreateTool {
    pub fn new(store: CronHandle) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for CronCreateTool {
    fn name(&self) -> &str {
        "CronCreate"
    }

    fn description(&self) -> &str {
        "Schedule a prompt to be enqueued at a future time. Use for both recurring schedules \
         and one-shot reminders. Standard 5-field cron in local time: minute hour day-of-month \
         month day-of-week (`0 9 * * *` = 9am local). One-shot: set recurring=false and pin the \
         exact minute/hour/day/month. Recurring (default): `*/5 * * * *`, `0 * * * *`, \
         `0 9 * * 1-5`. Avoid :00/:30 minutes when the request is approximate — pick a minute \
         that is not 0 or 30. Fired prompts arrive wrapped in a `<cron-fire>` XML envelope; \
         recurring tasks older than 7 days fire once more with `stale=\"true\"` then auto-expire."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "cron": {
                    "type": "string",
                    "description": "5-field cron expression in local time."
                },
                "prompt": {
                    "type": "string",
                    "description": "The prompt to enqueue at each fire time."
                },
                "recurring": {
                    "type": "boolean",
                    "description": "true (default) = fire on every cron match until deleted; false = fire once then auto-delete."
                }
            },
            "required": ["cron", "prompt"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let cron = arguments["cron"]
            .as_str()
            .ok_or("missing `cron` argument")?;
        let prompt = arguments["prompt"]
            .as_str()
            .ok_or("missing `prompt` argument")?;
        let recurring = arguments["recurring"].as_bool().unwrap_or(true);
        let task = self.store.lock().await.add(cron, prompt, recurring)?;
        Ok(format!(
            "Scheduled task {} (`{}`, {})",
            task.id,
            task.cron,
            if task.is_recurring() {
                "recurring"
            } else {
                "one-shot"
            }
        ))
    }
}

/// Cancel a scheduled task.
pub struct CronDeleteTool {
    store: CronHandle,
}

impl CronDeleteTool {
    pub fn new(store: CronHandle) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for CronDeleteTool {
    fn name(&self) -> &str {
        "CronDelete"
    }

    fn description(&self) -> &str {
        "Cancel a scheduled cron task by id."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Task id returned by CronCreate."
                }
            },
            "required": ["id"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let id = arguments["id"].as_str().ok_or("missing `id` argument")?;
        if self.store.lock().await.remove(id) {
            Ok(format!("Deleted scheduled task {id}"))
        } else {
            Err(format!("no scheduled task with id `{id}`"))
        }
    }
}

/// List scheduled tasks.
pub struct CronListTool {
    store: CronHandle,
}

impl CronListTool {
    pub fn new(store: CronHandle) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for CronListTool {
    fn name(&self) -> &str {
        "CronList"
    }

    fn description(&self) -> &str {
        "List all scheduled cron tasks (id, schedule, prompt)."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, _arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let store = self.store.lock().await;
        let tasks = store.list();
        if tasks.is_empty() {
            return Ok("No scheduled tasks.".to_string());
        }
        let mut output = String::new();
        for task in tasks {
            output.push_str(&format!(
                "{} · `{}` · {} · {}\n",
                task.id,
                task.cron,
                if task.is_recurring() {
                    "recurring"
                } else {
                    "one-shot"
                },
                task.prompt
            ));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle() -> CronHandle {
        Arc::new(Mutex::new(CronStore::default()))
    }

    #[tokio::test]
    async fn create_list_delete_round_trip() {
        let store = handle();
        let create = CronCreateTool::new(Arc::clone(&store));
        let list = CronListTool::new(Arc::clone(&store));
        let delete = CronDeleteTool::new(Arc::clone(&store));

        assert_eq!(
            list.execute(&json!({}), Path::new(".")).await.unwrap(),
            "No scheduled tasks."
        );
        let created = create
            .execute(
                &json!({ "cron": "*/5 * * * *", "prompt": "check" }),
                Path::new("."),
            )
            .await
            .unwrap();
        assert!(created.contains("recurring"), "{created}");
        let id = created.split_whitespace().nth(2).unwrap().to_string();

        let listed = list.execute(&json!({}), Path::new(".")).await.unwrap();
        assert!(listed.contains("check"), "{listed}");

        let deleted = delete
            .execute(&json!({ "id": id }), Path::new("."))
            .await
            .unwrap();
        assert!(deleted.contains("Deleted"), "{deleted}");
        assert!(
            delete
                .execute(&json!({ "id": id }), Path::new("."))
                .await
                .is_err()
        );

        // Invalid expressions are rejected with a helpful error.
        assert!(
            create
                .execute(&json!({ "cron": "nope", "prompt": "x" }), Path::new("."))
                .await
                .is_err()
        );
    }
}
