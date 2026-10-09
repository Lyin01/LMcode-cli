//! `TaskOutput` tool — read a background task's status and output tail
//! (the read side of `Bash(run_in_background: true)`).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::background::{BackgroundStatus, BackgroundTaskManager};

use super::Tool;

pub struct TaskOutputTool {
    manager: Arc<BackgroundTaskManager>,
}

impl TaskOutputTool {
    pub fn new(manager: Arc<BackgroundTaskManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> &str {
        "TaskOutput"
    }

    fn description(&self) -> &str {
        "Read a background task's status and output tail. Use it after \
         Bash(run_in_background: true) or for any long-running command. Set \
         `block` to wait briefly for the task to finish."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Task id returned by the Bash tool."
                },
                "block": {
                    "type": "boolean",
                    "description": "Wait for completion (polling) when the task is still running."
                },
                "timeout": {
                    "type": "integer",
                    "description": "Seconds to wait when `block` is true (default 30, max 300)."
                }
            },
            "required": ["task_id"]
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let id = arguments["task_id"]
            .as_str()
            .ok_or("missing `task_id` argument")?;
        let block = arguments["block"].as_bool() == Some(true);
        if block {
            let timeout = arguments["timeout"].as_u64().unwrap_or(30).min(300);
            let deadline = std::time::Instant::now() + Duration::from_secs(timeout);
            while std::time::Instant::now() < deadline {
                match self.manager.get(id) {
                    Some(info) if info.status.is_terminal() => break,
                    Some(_) => {}
                    None => break,
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        let info = self
            .manager
            .get(id)
            .ok_or_else(|| format!("unknown background task `{id}`"))?;
        let mut output = format!(
            "task {} · {} · {}\n",
            info.id,
            info.status.as_str(),
            info.command
        );
        if let Some(code) = info.exit_code {
            output.push_str(&format!("exit code: {code}\n"));
        }
        if info.status == BackgroundStatus::Running {
            output.push_str("(still running)\n");
        }
        output.push_str(&format!("output log: {}\n", info.output_path));
        if !info.output.is_empty() {
            output.push_str("--- output tail ---\n");
            output.push_str(&info.output);
            if !info.output.ends_with('\n') {
                output.push('\n');
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmcode-taskout-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn reads_completed_task_output() {
        let dir = temp_dir("read");
        let manager = Arc::new(BackgroundTaskManager::new(dir.join("tasks")));
        let tool = TaskOutputTool::new(Arc::clone(&manager));
        let info = manager.spawn("echo task-output-marker", &dir).unwrap();
        let report = tool
            .execute(
                &json!({ "task_id": info.id, "block": true, "timeout": 30 }),
                &dir,
            )
            .await
            .unwrap();
        assert!(report.contains("completed"), "{report}");
        assert!(report.contains("task-output-marker"), "{report}");

        let error = tool
            .execute(&json!({ "task_id": "task-nope" }), &dir)
            .await
            .unwrap_err();
        assert!(error.contains("unknown background task"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
