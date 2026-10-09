//! `TaskList` — list background tasks started by Bash.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::background::{BackgroundStatus, BackgroundTaskInfo, BackgroundTaskManager};

use super::Tool;

pub struct TaskListTool {
    manager: Arc<BackgroundTaskManager>,
}

impl TaskListTool {
    pub fn new(manager: Arc<BackgroundTaskManager>) -> Self {
        Self { manager }
    }
}

fn format_task(task: &BackgroundTaskInfo) -> String {
    let mut lines = vec![
        format!("task_id: {}", task.id),
        format!("status: {}", task.status.as_str()),
        format!("command: {}", task.command),
        format!("description: {}", task.description),
        format!(
            "pid: {}",
            task.pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "N/A".to_string())
        ),
    ];
    if task.status.is_terminal() {
        if let Some(code) = task.exit_code {
            lines.push(format!("exit_code: {code}"));
        }
        if let Some(reason) = task.stop_reason.as_deref() {
            lines.push(format!("reason: {reason}"));
        }
    }
    lines.join("\n")
}

pub(crate) fn format_task_list(tasks: &[BackgroundTaskInfo], active_only: bool) -> String {
    let label = if active_only {
        "active_background_tasks"
    } else {
        "background_tasks"
    };
    let header = format!("{label}: {}", tasks.len());
    if tasks.is_empty() {
        format!("{header}\nNo background tasks found.")
    } else {
        format!(
            "{header}\n{}",
            tasks
                .iter()
                .map(format_task)
                .collect::<Vec<_>>()
                .join("\n---\n")
        )
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn name(&self) -> &str {
        "TaskList"
    }

    fn description(&self) -> &str {
        "List background tasks. active_only defaults to true. Terminal tasks \
         include exit_code and, when stopped, reason."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "active_only": {
                    "type": "boolean",
                    "description": "Whether to list only non-terminal background tasks.",
                    "default": true
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Maximum number of tasks to return.",
                    "default": 20
                }
            }
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let active_only = match arguments.get("active_only") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err("active_only must be a boolean".to_string()),
        };
        let limit = match arguments.get("limit") {
            None => 20usize,
            Some(Value::Number(number)) => {
                let limit = number
                    .as_u64()
                    .filter(|limit| (1..=100).contains(limit))
                    .ok_or("limit must be an integer from 1 to 100")?;
                limit as usize
            }
            Some(_) => return Err("limit must be an integer from 1 to 100".to_string()),
        };
        let mut tasks: Vec<BackgroundTaskInfo> = self
            .manager
            .list()
            .into_iter()
            .filter(|task| !active_only || task.status == BackgroundStatus::Running)
            .collect();
        tasks.truncate(limit);
        Ok(format_task_list(&tasks, active_only))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn manager() -> Arc<BackgroundTaskManager> {
        let dir = std::env::temp_dir().join(format!(
            "lmcode-task-list-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(BackgroundTaskManager::new(dir))
    }

    #[tokio::test]
    async fn empty_active_list_names_the_count() {
        let tool = TaskListTool::new(manager());
        let output = tool.execute(&json!({}), Path::new(".")).await.unwrap();
        assert!(output.starts_with("active_background_tasks: 0"));
        assert!(output.contains("No background tasks found."));
    }

    #[tokio::test]
    async fn all_tasks_use_a_neutral_header_and_include_exit_code() {
        let tasks = manager();
        let tool = TaskListTool::new(Arc::clone(&tasks));
        let spawned = tasks
            .spawn("echo task-list-marker", Path::new("."))
            .unwrap();
        for _ in 0..40 {
            if tasks
                .get(&spawned.id)
                .is_some_and(|info| info.status.is_terminal())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let output = tool
            .execute(&json!({"active_only": false, "limit": 20}), Path::new("."))
            .await
            .unwrap();
        assert!(output.starts_with("background_tasks: 1"), "{output}");
        assert!(!output.contains("active_background_tasks"), "{output}");
        assert!(output.contains("exit_code:"), "{output}");
        assert!(output.contains(&spawned.id), "{output}");
        assert!(
            output.contains("command: echo task-list-marker"),
            "{output}"
        );
    }
}
