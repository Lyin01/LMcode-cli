//! Plan-mode tools: `EnterPlanMode` / `ExitPlanMode`
//! (mirrors `packages/agent-core/src/tools/builtin/planning`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::plan::PlanMode;

use super::Tool;

/// Shared plan-mode state, injected into both tools and the agent.
pub type PlanHandle = Arc<Mutex<PlanMode>>;

/// Where plan files live: `<home>/plans/<id>.md` (home = LMCODE home).
fn plans_base_dir() -> PathBuf {
    std::env::var_os("LMCODE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".lmcode"))
        })
        .unwrap_or_else(|| PathBuf::from(".lmcode"))
}

/// Enter plan mode: a read-only phase with one writable plan file.
pub struct EnterPlanModeTool {
    plan: PlanHandle,
}

impl EnterPlanModeTool {
    pub fn new(plan: PlanHandle) -> Self {
        Self { plan }
    }
}

#[async_trait]
impl Tool for EnterPlanModeTool {
    fn name(&self) -> &str {
        "EnterPlanMode"
    }

    fn description(&self) -> &str {
        "Enter plan mode for a non-trivial implementation task: a read-only \
         exploration phase where the only writable file is the plan file. \
         Prefer read-only tools; write the plan with Write/Edit, then call \
         ExitPlanMode to present it. Use it when ANY of these apply: new \
         feature implementation, multiple valid approaches, refactoring, \
         architectural decisions, multi-file changes, unclear requirements. \
         Do not use it for single-line fixes or pure research tasks."
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

    async fn execute(&self, _args: &Value, _cwd: &std::path::Path) -> Result<String, String> {
        let mut plan = self.plan.lock().await;
        if plan.is_active() {
            return Err("already in plan mode".to_string());
        }
        let path = plan
            .enter(&plans_base_dir(), true)
            .map_err(|error| format!("failed to enter plan mode: {error}"))?;
        Ok(format!(
            "Plan mode is active. Write your plan to {} with Write/Edit; \
             read-only tools are preferred and other file writes are blocked. \
             Call ExitPlanMode when the plan is ready for approval.",
            path.display()
        ))
    }
}

/// Exit plan mode, presenting the plan for approval.
pub struct ExitPlanModeTool {
    plan: PlanHandle,
}

impl ExitPlanModeTool {
    pub fn new(plan: PlanHandle) -> Self {
        Self { plan }
    }
}

#[async_trait]
impl Tool for ExitPlanModeTool {
    fn name(&self) -> &str {
        "ExitPlanMode"
    }

    fn description(&self) -> &str {
        "Exit plan mode and present the plan for approval. Call this once the \
         plan file is complete. Do not ask for plan approval in plain text — \
         this tool is the approval request."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "plan": {
                    "type": "string",
                    "description": "Optional plan summary shown with the approval request."
                }
            },
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, _args: &Value, _cwd: &std::path::Path) -> Result<String, String> {
        let mut plan = self.plan.lock().await;
        if !plan.is_active() {
            return Err("plan mode is not active".to_string());
        }
        let data = plan.data();
        plan.exit();
        match data {
            Some(data) if !data.content.trim().is_empty() => Ok(format!(
                "Plan approved for execution (plan file: {}). The read-only \
                 restrictions no longer apply.",
                data.path.display()
            )),
            _ => Ok("Exited plan mode. The read-only restrictions no longer apply.".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lmcode-planning-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn enter_then_exit_round_trip() {
        let base = temp_base("roundtrip");
        // SAFETY: single-threaded test process mutation of one env var.
        unsafe { std::env::set_var("LMCODE_HOME", &base) };
        let plan: PlanHandle = Arc::new(Mutex::new(PlanMode::default()));
        let enter = EnterPlanModeTool::new(Arc::clone(&plan));
        let exit = ExitPlanModeTool::new(Arc::clone(&plan));

        let message = enter
            .execute(&json!({}), std::path::Path::new("."))
            .await
            .unwrap();
        assert!(message.contains("Plan mode is active"), "{message}");
        assert!(plan.lock().await.is_active());

        // Double-enter is rejected.
        assert!(
            enter
                .execute(&json!({}), std::path::Path::new("."))
                .await
                .is_err()
        );

        let message = exit
            .execute(&json!({}), std::path::Path::new("."))
            .await
            .unwrap();
        assert!(message.contains("no longer apply"), "{message}");
        assert!(!plan.lock().await.is_active());
        // Exiting again is rejected.
        assert!(
            exit.execute(&json!({}), std::path::Path::new("."))
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
