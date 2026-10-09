//! Collaboration tools: `Agent` (one subagent) and `WolfPack` (parallel
//! subagents over independent items) — mirrors the TS collaboration tools.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::subagent::{SubagentProfile, SubagentRunner};

use super::Tool;

/// WolfPack caps the number of parallel subagents (mirrors `MAX_ITEMS`).
pub const WOLFPACK_MAX_ITEMS: usize = 20;

/// Launch a single subagent to handle a task.
pub struct AgentTool {
    runner: Arc<SubagentRunner>,
}

impl AgentTool {
    pub fn new(runner: Arc<SubagentRunner>) -> Self {
        Self { runner }
    }
}

#[async_trait]
impl Tool for AgentTool {
    fn name(&self) -> &str {
        "Agent"
    }

    fn description(&self) -> &str {
        "Launch a subagent to handle a task. The subagent starts with zero context — brief it \
         like a colleague who just walked in: state the goal, list known paths, hand over exact \
         commands. A subagent's result is only visible to you; summarize what the user needs to \
         see. Skip delegation for trivial one- or two-step work."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Full task prompt for the subagent"
                },
                "description": {
                    "type": "string",
                    "description": "Short task description (3-5 words) for UI display"
                },
                "subagent_type": {
                    "type": "string",
                    "description": "One of: coder (default), explore, plan, verify, writer."
                }
            },
            "required": ["prompt"]
        })
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let prompt = arguments["prompt"]
            .as_str()
            .ok_or("missing `prompt` argument")?;
        let profile = arguments["subagent_type"]
            .as_str()
            .map(SubagentProfile::from_name)
            .unwrap_or(SubagentProfile::Coder);
        self.runner.run(profile, prompt).await
    }
}

/// Spawn multiple subagents in parallel over independent items.
pub struct WolfPackTool {
    runner: Arc<SubagentRunner>,
}

impl WolfPackTool {
    pub fn new(runner: Arc<SubagentRunner>) -> Self {
        Self { runner }
    }
}

#[async_trait]
impl Tool for WolfPackTool {
    fn name(&self) -> &str {
        "WolfPack"
    }

    fn description(&self) -> &str {
        "Spawn multiple subagents in parallel for batch operations. Ideal for processing many \
         independent items (files, checks, searches) that follow the same pattern. Items must \
         be independent — if items depend on each other, use separate Agent calls instead."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Brief (3-5 word) task summary"
                },
                "subagent_type": {
                    "type": "string",
                    "description": "Subagent profile name (defaults to coder)"
                },
                "prompt_template": {
                    "type": "string",
                    "description": "Prompt pattern where each item value is substituted for {{item}}"
                },
                "items": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Items to process; each gets its own subagent (max 20)"
                }
            },
            "required": ["prompt_template", "items"]
        })
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let template = arguments["prompt_template"]
            .as_str()
            .ok_or("missing `prompt_template` argument")?;
        let items: Vec<String> = arguments["items"]
            .as_array()
            .ok_or("missing `items` argument")?
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect();
        if items.is_empty() {
            return Err("`items` must not be empty".to_string());
        }
        if items.len() > WOLFPACK_MAX_ITEMS {
            return Err(format!(
                "WolfPack max {WOLFPACK_MAX_ITEMS} items. Got {}.",
                items.len()
            ));
        }
        let profile = arguments["subagent_type"]
            .as_str()
            .map(SubagentProfile::from_name)
            .unwrap_or(SubagentProfile::Coder);
        let description = arguments["description"].as_str().unwrap_or("wolfpack");

        // Run every item in parallel; order is restored before reporting.
        let mut set = tokio::task::JoinSet::new();
        for (index, item) in items.iter().cloned().enumerate() {
            let runner = Arc::clone(&self.runner);
            let prompt = template.replace("{{item}}", &item);
            set.spawn(async move { (index, item, runner.run(profile, &prompt).await) });
        }
        let mut results: Vec<(usize, String, Result<String, String>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(result) => results.push(result),
                Err(error) => results.push((usize::MAX, String::new(), Err(error.to_string()))),
            }
        }
        results.sort_by_key(|(index, _, _)| *index);

        let mut output = format!("WolfPack: {description} ({} agents)\n", items.len());
        for (index, item, result) in results {
            output.push_str(&format!("\n=== item {index}: {item} ===\n"));
            match result {
                Ok(text) => output.push_str(&text),
                Err(error) => output.push_str(&format!("error: {error}")),
            }
            output.push('\n');
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wolfpack_cap_matches_the_ts_tool() {
        assert_eq!(WOLFPACK_MAX_ITEMS, 20);
    }
}
