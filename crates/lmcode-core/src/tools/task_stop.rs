//! `TaskStop` — stop one background task and record the reason.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::background::{BackgroundTaskInfo, BackgroundTaskManager};

use super::Tool;

const DEFAULT_REASON: &str = "Stopped by TaskStop";

pub struct TaskStopTool {
    manager: Arc<BackgroundTaskManager>,
}

impl TaskStopTool {
    pub fn new(manager: Arc<BackgroundTaskManager>) -> Self {
        Self { manager }
    }
}

fn reason_from_args(arguments: &Value) -> Result<String, String> {
    match arguments.get("reason") {
        None => Ok(DEFAULT_REASON.to_string()),
        Some(Value::String(reason)) => {
            let trimmed = reason.trim();
            if trimmed.is_empty() {
                Ok(DEFAULT_REASON.to_string())
            } else {
                Ok(trimmed.to_string())
            }
        }
        Some(_) => Err("reason must be a string".to_string()),
    }
}

fn terminal_reason(reason: Option<&str>) -> &str {
    match reason.map(str::trim) {
        Some(reason) if !reason.is_empty() => reason,
        _ => "Task already in terminal state",
    }
}

fn format_stop(info: &BackgroundTaskInfo, reason: &str) -> String {
    format!(
        "task_id: {}\nstatus: {}\nreason: {reason}",
        info.id,
        info.status.as_str()
    )
}

#[async_trait]
impl Tool for TaskStopTool {
    fn name(&self) -> &str {
        "TaskStop"
    }

    fn description(&self) -> &str {
        "Stop a running background task by id. A blank reason is recorded as \
         \"Stopped by TaskStop\". An already finished task is reported, not killed again."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task_id": { "type": "string", "description": "The background task ID to stop." },
                "reason": {
                    "type": "string",
                    "description": "Short reason recorded when the task is stopped.",
                    "default": DEFAULT_REASON
                }
            },
            "required": ["task_id"]
        })
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let task_id = arguments["task_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("missing `task_id` argument")?;
        let reason = reason_from_args(arguments)?;
        let Some(info) = self.manager.get(task_id) else {
            return Err(format!("Task not found: {task_id}"));
        };
        if info.status.is_terminal() {
            let shown = terminal_reason(info.stop_reason.as_deref()).to_string();
            return Ok(format_stop(&info, &shown));
        }
        match self.manager.stop(task_id, &reason) {
            Ok(stopped) => {
                let shown = stopped
                    .stop_reason
                    .clone()
                    .unwrap_or_else(|| reason.clone());
                Ok(format_stop(&stopped, &shown))
            }
            Err(_) => match self.manager.get(task_id) {
                Some(info) if info.status.is_terminal() => {
                    let shown = terminal_reason(info.stop_reason.as_deref()).to_string();
                    Ok(format_stop(&info, &shown))
                }
                Some(_) => Err(format!("Failed to stop task: {task_id}")),
                None => Err(format!("Task not found: {task_id}")),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> Arc<BackgroundTaskManager> {
        let dir = std::env::temp_dir().join(format!(
            "lmcode-task-stop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(BackgroundTaskManager::new(dir))
    }

    fn long_command() -> &'static str {
        if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        }
    }

    #[tokio::test]
    async fn missing_task_is_an_error() {
        let tool = TaskStopTool::new(manager());
        let error = tool
            .execute(&json!({"task_id": "missing"}), Path::new("."))
            .await
            .unwrap_err();
        assert!(error.contains("Task not found: missing"), "{error}");
    }

    #[tokio::test]
    async fn blank_reason_uses_the_default_and_marks_the_task_killed() {
        let tasks = manager();
        let tool = TaskStopTool::new(Arc::clone(&tasks));
        let spawned = tasks.spawn(long_command(), Path::new(".")).unwrap();
        let output = tool
            .execute(
                &json!({"task_id": spawned.id, "reason": "   "}),
                Path::new("."),
            )
            .await
            .unwrap();
        assert!(output.contains("status: killed"), "{output}");
        assert!(output.contains("reason: Stopped by TaskStop"), "{output}");
        assert_eq!(
            tasks.get(&spawned.id).unwrap().stop_reason.as_deref(),
            Some("Stopped by TaskStop")
        );
    }

    #[tokio::test]
    async fn an_already_finished_task_reports_three_lines() {
        let tasks = manager();
        let tool = TaskStopTool::new(Arc::clone(&tasks));
        let spawned = tasks.spawn("echo stopped-already", Path::new(".")).unwrap();
        for _ in 0..40 {
            if tasks
                .get(&spawned.id)
                .is_some_and(|info| info.status.is_terminal())
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let output = tool
            .execute(&json!({"task_id": spawned.id}), Path::new("."))
            .await
            .unwrap();
        let lines: Vec<&str> = output.trim().lines().collect();
        assert_eq!(lines.len(), 3, "{output}");
        assert!(lines[0].starts_with("task_id:"));
        assert!(lines[1].starts_with("status:"));
        assert!(lines[2].starts_with("reason:"));
    }
}
