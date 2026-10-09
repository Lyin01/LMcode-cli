//! Session-level usage accounting: per-model token totals plus coarse
//! observability counters (LLM steps, tool calls, compactions), mirroring the
//! TS `UsageRecorder` in `packages/agent-core/src/agent/usage`.

use std::collections::HashMap;

use lmcode_llm::usage::TokenUsage;
use serde::Serialize;

/// Immutable snapshot for UI/reporting.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub total: TokenUsage,
    pub by_model: Vec<ModelUsage>,
    pub llm_steps: u64,
    pub tool_calls: u64,
    pub compactions: u64,
    /// Most-used tools, descending (top five).
    pub top_tools: Vec<ToolUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub name: String,
    pub calls: u64,
}

/// Accumulates usage across a session.
#[derive(Debug, Default)]
pub struct UsageRecorder {
    by_model: HashMap<String, TokenUsage>,
    llm_steps: u64,
    tool_calls: u64,
    tool_calls_by_name: HashMap<String, u64>,
    compactions: u64,
}

impl UsageRecorder {
    /// Add one model response's usage.
    pub fn record(&mut self, model: &str, usage: TokenUsage) {
        let entry = self.by_model.entry(model.to_string()).or_default();
        entry.input_tokens += usage.input_tokens;
        entry.output_tokens += usage.output_tokens;
        if let Some(cache_read) = usage.cache_read_tokens {
            let current = entry.cache_read_tokens.unwrap_or(0);
            entry.cache_read_tokens = Some(current + cache_read);
        }
    }

    /// Count one completed LLM step (one model generation in the turn loop).
    pub fn record_llm_step(&mut self) {
        self.llm_steps += 1;
    }

    /// Count one tool execution, bucketed by tool name.
    pub fn record_tool_call(&mut self, name: &str) {
        self.tool_calls += 1;
        *self.tool_calls_by_name.entry(name.to_string()).or_insert(0) += 1;
    }

    /// Count one compaction (micro or full).
    pub fn record_compaction(&mut self) {
        self.compactions += 1;
    }

    /// Session totals plus counters, ready for display.
    pub fn snapshot(&self) -> UsageSnapshot {
        let mut by_model: Vec<ModelUsage> = self
            .by_model
            .iter()
            .map(|(model, usage)| ModelUsage {
                model: model.clone(),
                usage: *usage,
            })
            .collect();
        by_model.sort_by(|a, b| a.model.cmp(&b.model));
        let total = by_model
            .iter()
            .fold(TokenUsage::default(), |mut total, entry| {
                total.input_tokens += entry.usage.input_tokens;
                total.output_tokens += entry.usage.output_tokens;
                if let Some(cache_read) = entry.usage.cache_read_tokens {
                    let current = total.cache_read_tokens.unwrap_or(0);
                    total.cache_read_tokens = Some(current + cache_read);
                }
                total
            });
        let mut top_tools: Vec<ToolUsage> = self
            .tool_calls_by_name
            .iter()
            .map(|(name, calls)| ToolUsage {
                name: name.clone(),
                calls: *calls,
            })
            .collect();
        top_tools.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));
        top_tools.truncate(5);
        UsageSnapshot {
            total,
            by_model,
            llm_steps: self.llm_steps,
            tool_calls: self.tool_calls,
            compactions: self.compactions,
            top_tools,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_usage_across_models() {
        let mut recorder = UsageRecorder::default();
        recorder.record(
            "a",
            TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: Some(3),
            },
        );
        recorder.record(
            "a",
            TokenUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: None,
            },
        );
        recorder.record(
            "b",
            TokenUsage {
                input_tokens: 7,
                output_tokens: 0,
                cache_read_tokens: None,
            },
        );
        recorder.record_llm_step();
        recorder.record_tool_call("Bash");
        recorder.record_tool_call("Bash");
        recorder.record_tool_call("Read");
        recorder.record_compaction();

        let snapshot = recorder.snapshot();
        assert_eq!(snapshot.total.input_tokens, 18);
        assert_eq!(snapshot.total.output_tokens, 7);
        assert_eq!(snapshot.total.cache_read_tokens, Some(3));
        assert_eq!(snapshot.by_model.len(), 2);
        assert_eq!(snapshot.by_model[0].model, "a");
        assert_eq!(snapshot.by_model[0].usage.input_tokens, 11);
        assert_eq!(snapshot.by_model[0].usage.cache_read_tokens, Some(3));
        assert_eq!(snapshot.llm_steps, 1);
        assert_eq!(snapshot.tool_calls, 3);
        assert_eq!(snapshot.compactions, 1);
        assert_eq!(snapshot.top_tools[0].name, "Bash");
        assert_eq!(snapshot.top_tools[0].calls, 2);
        assert_eq!(snapshot.top_tools[1].name, "Read");
    }
}
