//! Goal-mode tools: `CreateGoal` / `GetGoal` / `SetGoalBudget` / `UpdateGoal`
//! / `WriteGoalNote` (mirrors `packages/agent-core/src/tools/builtin/goal`).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::goal::{GoalMode, GoalStatus};

use super::Tool;

/// Shared goal state, injected into both the tools and the agent.
pub type GoalHandle = Arc<Mutex<GoalMode>>;

fn snapshot_json(snapshot: &crate::goal::GoalSnapshot) -> Result<String, String> {
    serde_json::to_string_pretty(snapshot).map_err(|error| error.to_string())
}

/// Create a durable goal for the current session.
pub struct CreateGoalTool {
    goal: GoalHandle,
}

impl CreateGoalTool {
    pub fn new(goal: GoalHandle) -> Self {
        Self { goal }
    }
}

#[async_trait]
impl Tool for CreateGoalTool {
    fn name(&self) -> &str {
        "CreateGoal"
    }

    fn description(&self) -> &str {
        "Create a durable goal for the current session. The goal becomes structured state that \
         the agent pursues autonomously through continuation turns until completion or blockage."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "description": "The objective to pursue. Must have a verifiable end state."
                },
                "completionCriterion": {
                    "type": "string",
                    "description": "How to verify the goal is complete. Include when the user provides one."
                },
                "replace": {
                    "type": "boolean",
                    "description": "Replace an existing active or paused goal instead of failing."
                }
            },
            "required": ["objective"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let objective = arguments["objective"]
            .as_str()
            .ok_or("missing `objective` argument")?;
        let criterion = arguments["completionCriterion"].as_str();
        let replace = arguments["replace"].as_bool().unwrap_or(false);
        let snapshot = self
            .goal
            .lock()
            .await
            .create(objective, criterion, replace)?;
        snapshot_json(&snapshot)
    }
}

/// Read the current goal snapshot.
pub struct GetGoalTool {
    goal: GoalHandle,
}

impl GetGoalTool {
    pub fn new(goal: GoalHandle) -> Self {
        Self { goal }
    }
}

#[async_trait]
impl Tool for GetGoalTool {
    fn name(&self) -> &str {
        "GetGoal"
    }

    fn description(&self) -> &str {
        "Return the current goal snapshot (objective, status, budgets, and usage counters) so you \
         can decide whether to continue, report completion, or report a blocker."
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
        match self.goal.lock().await.snapshot() {
            Some(snapshot) => snapshot_json(&snapshot),
            None => Ok("{\n  \"goal\": null\n}".to_string()),
        }
    }
}

/// Set one hard budget limit (turns / tokens / time).
pub struct SetGoalBudgetTool {
    goal: GoalHandle,
}

impl SetGoalBudgetTool {
    pub fn new(goal: GoalHandle) -> Self {
        Self { goal }
    }
}

#[async_trait]
impl Tool for SetGoalBudgetTool {
    fn name(&self) -> &str {
        "SetGoalBudget"
    }

    fn description(&self) -> &str {
        "Set a hard budget limit for the current goal. Accepts one limit at a time (turns, \
         tokens, or time). The goal becomes blocked when the budget is exhausted. Do not invent \
         budgets; only set one the user explicitly requested."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "unit": {
                    "type": "string",
                    "description": "One of: turns, tokens, milliseconds, seconds, minutes, hours."
                },
                "value": {
                    "type": "number",
                    "description": "The positive numeric budget value."
                }
            },
            "required": ["unit", "value"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let unit = arguments["unit"]
            .as_str()
            .ok_or("missing `unit` argument")?;
        let value = arguments["value"]
            .as_u64()
            .ok_or("`value` must be a positive integer")?;
        if value == 0 {
            return Err("`value` must be a positive integer".to_string());
        }
        let mut goal = self.goal.lock().await;
        let mut limits = goal
            .current()
            .ok_or("no goal to set a budget on")?
            .budget_limits
            .clone();
        match unit {
            "turns" => limits.turn_budget = Some(value),
            "tokens" => limits.token_budget = Some(value),
            "milliseconds" => limits.wall_clock_budget_ms = Some(value),
            "seconds" => limits.wall_clock_budget_ms = Some(value.saturating_mul(1000)),
            "minutes" => limits.wall_clock_budget_ms = Some(value.saturating_mul(60_000)),
            "hours" => limits.wall_clock_budget_ms = Some(value.saturating_mul(3_600_000)),
            other => return Err(format!("unknown budget unit `{other}`")),
        }
        let snapshot = goal.set_budget(limits)?;
        snapshot_json(&snapshot)
    }
}

/// Provider + evidence snapshot used to verify `complete` transitions.
pub struct GoalGrader {
    pub provider: Arc<dyn lmcode_llm::provider::ChatProvider>,
    pub evidence: Arc<Mutex<String>>,
}

/// Update the goal lifecycle status.
pub struct UpdateGoalTool {
    goal: GoalHandle,
    grader: Option<GoalGrader>,
}

impl UpdateGoalTool {
    pub fn new(goal: GoalHandle) -> Self {
        Self { goal, grader: None }
    }

    /// Variant that verifies `complete` transitions with the goal grader.
    pub fn with_grader(goal: GoalHandle, grader: GoalGrader) -> Self {
        Self {
            goal,
            grader: Some(grader),
        }
    }
}

#[async_trait]
impl Tool for UpdateGoalTool {
    fn name(&self) -> &str {
        "UpdateGoal"
    }

    fn description(&self) -> &str {
        "Update the current goal's lifecycle status. Use `complete` when all required work is \
         done and validation has passed, `blocked` when an external condition prevents progress, \
         `paused` to park it, or `active` to resume."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "One of: active, complete, blocked, paused."
                },
                "terminal_reason": {
                    "type": "string",
                    "description": "Short reason recorded for `complete` / `blocked`."
                }
            },
            "required": ["status"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let name = arguments["status"]
            .as_str()
            .ok_or("missing `status` argument")?;
        let status =
            GoalStatus::from_name(name).ok_or_else(|| format!("unknown goal status `{name}`"))?;
        let reason = arguments["terminal_reason"].as_str();
        // Completing a goal requires an independent grader verdict.
        if status == GoalStatus::Complete
            && let Some(grader) = &self.grader
        {
            let (objective, criterion) = {
                let goal = self.goal.lock().await;
                let Some(current) = goal.current() else {
                    return Err("no goal to update".to_string());
                };
                (
                    current.objective.clone(),
                    current.completion_criterion.clone(),
                )
            };
            let criteria = match criterion {
                Some(criterion) => criterion,
                None => {
                    crate::grader::generate_criteria(Arc::clone(&grader.provider), &objective).await
                }
            };
            let criteria = if criteria.trim().is_empty() {
                "No specific criteria were defined. Require clear evidence that the objective is \
                 fully achieved."
                    .to_string()
            } else {
                criteria
            };
            let evidence = grader.evidence.lock().await.clone();
            let verdict = crate::grader::run_grader(
                Arc::clone(&grader.provider),
                &objective,
                &criteria,
                &evidence,
            )
            .await;
            if !verdict.pass {
                return Err(format!(
                    "Goal completion was not verified:\n{}",
                    verdict.reason
                ));
            }
        }
        let snapshot = self.goal.lock().await.update_status(status, reason)?;
        snapshot_json(&snapshot)
    }
}

/// Record a durable working note on the current goal.
pub struct WriteGoalNoteTool {
    goal: GoalHandle,
}

impl WriteGoalNoteTool {
    pub fn new(goal: GoalHandle) -> Self {
        Self { goal }
    }
}

#[async_trait]
impl Tool for WriteGoalNoteTool {
    fn name(&self) -> &str {
        "WriteGoalNote"
    }

    fn description(&self) -> &str {
        "Record a durable working note on the current goal (max 10 notes × 200 characters). Use \
         it to persist important findings between continuation turns."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "note": {
                    "type": "string",
                    "description": "The note content (max 200 characters)."
                }
            },
            "required": ["note"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let note = arguments["note"]
            .as_str()
            .ok_or("missing `note` argument")?;
        let snapshot = self.goal.lock().await.add_note(note)?;
        snapshot_json(&snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle() -> GoalHandle {
        Arc::new(Mutex::new(GoalMode::default()))
    }

    #[tokio::test]
    async fn create_get_and_update_round_trip() {
        let goal = handle();
        let create = CreateGoalTool::new(Arc::clone(&goal));
        let get = GetGoalTool::new(Arc::clone(&goal));
        let update = UpdateGoalTool::new(Arc::clone(&goal));

        assert_eq!(
            get.execute(&json!({}), Path::new(".")).await.unwrap(),
            "{\n  \"goal\": null\n}"
        );

        let created = create
            .execute(&json!({ "objective": "finish the port" }), Path::new("."))
            .await
            .unwrap();
        assert!(created.contains("\"status\": \"active\""), "{created}");

        // Double-create without replace fails.
        assert!(
            create
                .execute(&json!({ "objective": "other" }), Path::new("."))
                .await
                .is_err()
        );

        let updated = update
            .execute(
                &json!({ "status": "complete", "terminal_reason": "done" }),
                Path::new("."),
            )
            .await
            .unwrap();
        assert!(updated.contains("\"status\": \"complete\""), "{updated}");
        assert!(
            updated.contains("\"terminalReason\": \"done\""),
            "{updated}"
        );
        assert!(
            update
                .execute(&json!({ "status": "bogus" }), Path::new("."))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn budget_units_convert_and_notes_accumulate() {
        let goal = handle();
        CreateGoalTool::new(Arc::clone(&goal))
            .execute(&json!({ "objective": "g" }), Path::new("."))
            .await
            .unwrap();
        let set_budget = SetGoalBudgetTool::new(Arc::clone(&goal));
        let report = set_budget
            .execute(&json!({ "unit": "minutes", "value": 30 }), Path::new("."))
            .await
            .unwrap();
        assert!(
            report.contains("\"wallClockBudgetMs\": 1800000"),
            "{report}"
        );
        assert!(
            set_budget
                .execute(&json!({ "unit": "weeks", "value": 1 }), Path::new("."))
                .await
                .is_err()
        );
        assert!(
            set_budget
                .execute(&json!({ "unit": "turns", "value": 0 }), Path::new("."))
                .await
                .is_err()
        );

        let note = WriteGoalNoteTool::new(Arc::clone(&goal));
        let snapshot = note
            .execute(&json!({ "note": "remember me" }), Path::new("."))
            .await
            .unwrap();
        assert!(snapshot.contains("remember me"), "{snapshot}");
    }
}
