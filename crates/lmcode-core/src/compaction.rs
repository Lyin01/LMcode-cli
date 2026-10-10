//! Compaction pipeline — token estimation, micro truncation, and full
//! summarization planning.
//!
//! Mirrors the core contract of `packages/agent-core/src/agent/compaction/`:
//! micro compaction clears old tool results (>= 50% usage, capped at 200k
//! estimated tokens) with zero LLM cost; full compaction splits off old
//! messages for LLM summarization at >= 75%; the blocking threshold sits at
//! 85%. Micro compaction is a *projection* — it shapes what gets sent to the
//! model without mutating the stored history.

use std::collections::HashMap;

use lmcode_llm::message::{ContentPart, Message, Role};

// Micro compaction defaults (aligned with the TS implementation).
pub const MICRO_KEEP_RECENT: usize = 20;
pub const MICRO_MIN_CONTENT_TOKENS: u64 = 100;
pub const MICRO_MIN_USAGE_RATIO: f64 = 0.5;
pub const MICRO_WORKING_SET_TOKENS: u64 = 200_000;
pub const MICRO_MARKER: &str = "[Old tool result content cleared]";

// Full compaction defaults.
pub const FULL_TRIGGER_RATIO: f64 = 0.75;
pub const BLOCK_RATIO: f64 = 0.85;
pub const FULL_MAX_RECENT_MESSAGES: usize = 16;
pub const FULL_MAX_RECENT_SIZE_RATIO: f64 = 0.2;
pub const TURN_GROWTH_MULTIPLIER: f64 = 2.5;
pub const FAILURE_BREAKER_THRESHOLD: u32 = 3;

/// Estimate tokens for a string: ASCII runs at ~4 chars/token, non-ASCII
/// characters count one token each (mirrors `estimateTokens`).
pub fn estimate_tokens(text: &str) -> u64 {
    let mut ascii = 0u64;
    let mut non_ascii = 0u64;
    for character in text.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    ascii.div_ceil(4) + non_ascii
}

/// Estimate tokens for one message (content parts + tool calls).
pub fn estimate_tokens_for_message(message: &Message) -> u64 {
    let mut total = estimate_tokens(role_name(message.role));
    for part in &message.content {
        match part {
            ContentPart::Text { text } => total += estimate_tokens(text),
            ContentPart::Think { think, .. } => total += estimate_tokens(think),
            // Images/videos are billed by resolution/duration; a flat
            // allowance is enough for threshold math.
            ContentPart::ImageUrl { .. } => total += 1_000,
            ContentPart::VideoUrl { .. } => total += 2_000,
            ContentPart::AudioUrl { .. } => total += 1_000,
        }
    }
    for call in &message.tool_calls {
        total += estimate_tokens(&call.name);
        if let Some(arguments) = &call.arguments {
            total += estimate_tokens(arguments);
        }
    }
    total
}

/// Estimate tokens for a message list.
pub fn estimate_tokens_for_messages(messages: &[Message]) -> u64 {
    messages.iter().map(estimate_tokens_for_message).sum()
}

/// Render a message list as plain text for the summarizer prompt.
pub fn render_messages(messages: &[Message]) -> String {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let header = format!(
                "--- message {} role={} ---",
                index + 1,
                role_name(message.role)
            );
            let mut lines = vec![header];
            for part in &message.content {
                match part {
                    ContentPart::Text { text } => lines.push(text.clone()),
                    ContentPart::Think { think, .. } => {
                        lines.push(format!("[thinking]\n{think}"));
                    }
                    ContentPart::ImageUrl { .. } => lines.push("[image]".to_string()),
                    ContentPart::VideoUrl { .. } => lines.push("[video]".to_string()),
                    ContentPart::AudioUrl { .. } => lines.push("[audio]".to_string()),
                }
            }
            if !message.tool_calls.is_empty() {
                lines.push("tool calls:".to_string());
                for call in &message.tool_calls {
                    lines.push(format!(
                        "  {} {} {}",
                        call.id,
                        call.name,
                        call.arguments.as_deref().unwrap_or("{}")
                    ));
                }
            }
            if message.content.is_empty() && message.tool_calls.is_empty() {
                lines.push("[empty content]".to_string());
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

/// State machine for the compaction pipeline.
#[derive(Debug, Clone)]
pub struct CompactionPipeline {
    /// Model context window; `0` disables compaction entirely.
    max_context_tokens: u64,
    /// Model output budget, used for turn-growth prediction.
    max_output_tokens: u64,
    /// Index before which tool results get truncated by micro compaction.
    micro_cutoff: usize,
    /// Consecutive full-compaction failures (circuit breaker).
    consecutive_failures: u32,
}

impl CompactionPipeline {
    pub fn new(max_context_tokens: u64, max_output_tokens: u64) -> Self {
        Self {
            max_context_tokens,
            max_output_tokens,
            micro_cutoff: 0,
            consecutive_failures: 0,
        }
    }

    /// A pipeline that never compacts.
    pub fn disabled() -> Self {
        Self::new(0, 0)
    }

    pub fn max_context_tokens(&self) -> u64 {
        self.max_context_tokens
    }

    pub fn micro_cutoff(&self) -> usize {
        self.micro_cutoff
    }

    pub fn breaker_open(&self) -> bool {
        self.consecutive_failures >= FAILURE_BREAKER_THRESHOLD
    }

    pub fn record_failure(&mut self) {
        self.consecutive_failures += 1;
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
    }

    /// Drop the micro cutoff (called after a full compaction).
    pub fn reset_micro(&mut self) {
        self.micro_cutoff = 0;
    }

    /// Micro-compaction trigger: 50% of the window, capped at 200k tokens.
    pub fn should_micro(&self, used: u64) -> bool {
        if self.max_context_tokens == 0 {
            return false;
        }
        let ratio_trigger = (self.max_context_tokens as f64 * MICRO_MIN_USAGE_RATIO) as u64;
        let trigger = ratio_trigger.min(MICRO_WORKING_SET_TOKENS);
        used >= trigger
    }

    /// Full-compaction trigger (75%).
    pub fn should_compact(&self, used: u64) -> bool {
        if self.max_context_tokens == 0 {
            return false;
        }
        used as f64 >= self.max_context_tokens as f64 * FULL_TRIGGER_RATIO
    }

    /// Blocking threshold (85%): compaction must succeed before continuing.
    pub fn should_block(&self, used: u64) -> bool {
        if self.max_context_tokens == 0 {
            return false;
        }
        used as f64 >= self.max_context_tokens as f64 * BLOCK_RATIO
    }

    /// Worst-case token growth for one step (output + proportional tool results).
    pub fn estimate_turn_growth(&self) -> u64 {
        (self.max_output_tokens as f64 * TURN_GROWTH_MULTIPLIER) as u64
    }

    /// Whether to compact proactively before the next call would overflow.
    pub fn should_compact_proactively(&self, used: u64) -> bool {
        if self.max_context_tokens == 0 {
            return false;
        }
        used + self.estimate_turn_growth() >= self.max_context_tokens
    }

    /// Project the message list for the model: advance the micro cutoff when
    /// the trigger fires, then replace old tool results with markers.
    ///
    /// Never mutates the stored history — the returned list is what gets sent.
    pub fn apply_micro(&mut self, messages: &[Message]) -> Vec<Message> {
        let used = estimate_tokens_for_messages(messages);
        if self.should_micro(used) {
            self.micro_cutoff = messages.len().saturating_sub(MICRO_KEEP_RECENT);
        }
        if self.micro_cutoff == 0 {
            return messages.to_vec();
        }
        let superseded = find_superseded_paths(messages, self.micro_cutoff);
        messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                if index < self.micro_cutoff
                    && message.role == Role::Tool
                    && estimate_tokens_for_message(message) >= MICRO_MIN_CONTENT_TOKENS
                {
                    let marker = match message
                        .tool_call_id
                        .as_ref()
                        .and_then(|id| superseded.get(id))
                    {
                        Some(path) => format!("[Superseded by a newer read of {path}]"),
                        None => MICRO_MARKER.to_string(),
                    };
                    let mut truncated = message.clone();
                    truncated.content = vec![ContentPart::Text { text: marker }];
                    truncated
                } else {
                    message.clone()
                }
            })
            .collect()
    }

    /// Plan a full-compaction split: how many leading messages to summarize.
    ///
    /// Returns `None` when no safe split exists. Mirrors the TS
    /// `computeCompactCount` auto rules: the split must be safe, at least one
    /// recent message is preserved, and at most `FULL_MAX_RECENT_MESSAGES` /
    /// 20% of the window worth of messages are preserved.
    pub fn plan_full_split(&self, messages: &[Message]) -> Option<usize> {
        if messages.len() < 2 {
            return None;
        }
        let max_recent_size = (self.max_context_tokens as f64 * FULL_MAX_RECENT_SIZE_RATIO) as u64;
        let mut recent_messages = 1usize;
        let mut recent_size = 0u64;
        let mut best: Option<usize> = None;

        while recent_messages < messages.len() {
            let split_index = messages.len() - recent_messages - 1;
            recent_size += estimate_tokens_for_message(&messages[messages.len() - recent_messages]);
            if can_split_after(messages, split_index) {
                best = Some(split_index + 1);
            }
            let reaches_max = recent_messages >= FULL_MAX_RECENT_MESSAGES
                || (max_recent_size > 0 && recent_size >= max_recent_size);
            if reaches_max && best.is_some() {
                break;
            }
            recent_messages += 1;
        }
        best
    }

    /// Manual `/compact`: summarize the longest safe prefix.
    ///
    /// Mirrors `computeCompactCount` for `source: 'manual'`. A one-message
    /// history cannot be split. The returned count is how many leading
    /// messages the summary replaces.
    pub fn plan_manual_split(messages: &[Message]) -> Option<usize> {
        if messages.len() < 2 {
            return None;
        }
        let mut index = messages.len() - 1;
        while index > 0 {
            if can_split_after(messages, index) {
                return Some(index + 1);
            }
            index -= 1;
        }
        None
    }
}

/// A split after `index` is safe when the message is neither a user message
/// nor an assistant message with pending tool calls, and the suffix does not
/// start with an orphaned tool result.
fn can_split_after(messages: &[Message], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    if message.role == Role::User {
        return false;
    }
    if message.role == Role::Assistant && !message.tool_calls.is_empty() {
        return false;
    }
    if messages
        .get(index + 1)
        .map(|next| next.role == Role::Tool)
        .unwrap_or(false)
    {
        return false;
    }
    true
}

/// Tool call ids of `Read` calls superseded by a later read of the same path,
/// restricted to calls before the cutoff.
fn find_superseded_paths(messages: &[Message], cutoff: usize) -> HashMap<String, String> {
    let mut superseded = HashMap::new();
    let mut read_calls: HashMap<String, (String, usize)> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if message.role != Role::Assistant || message.tool_calls.is_empty() {
            continue;
        }
        for call in &message.tool_calls {
            if call.name != "Read" {
                continue;
            }
            let Some(arguments) = &call.arguments else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(arguments) else {
                continue;
            };
            let Some(path) = parsed["path"].as_str() else {
                continue;
            };
            if let Some((prior_id, prior_index)) = read_calls.get(path)
                && *prior_index < cutoff
            {
                superseded.insert(prior_id.clone(), path.to_string());
            }
            read_calls.insert(path.to_string(), (call.id.clone(), index));
        }
    }
    superseded
}

#[cfg(test)]
mod tests {
    use super::*;
    use lmcode_llm::message::ToolCall;

    #[test]
    fn estimates_ascii_and_non_ascii_tokens() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens(""), 0);
        // Non-ASCII counts one token per character.
        assert_eq!(estimate_tokens("你好"), 2);
        // Mixed: 4 ASCII chars -> 1 token, plus 2 CJK chars.
        assert_eq!(estimate_tokens("abcd你好"), 3);
    }

    fn tool_result_message(id: &str, content: &str) -> Message {
        Message::tool_result(id, content)
    }

    #[test]
    fn micro_truncates_old_tool_results_only() {
        let mut messages = Vec::new();
        for index in 0..30 {
            messages.push(Message::user(format!("question {index}")));
            messages.push(tool_result_message(
                &format!("call_{index}"),
                &"x".repeat(500),
            ));
        }
        let used = estimate_tokens_for_messages(&messages);
        // 5000-token window -> micro triggers at 2500.
        let mut pipeline = CompactionPipeline::new(5_000, 1_000);
        assert!(pipeline.should_micro(used), "used={used}");

        let projected = pipeline.apply_micro(&messages);

        // 60 messages, keep the last 20 -> first 40 are before the cutoff.
        assert_eq!(pipeline.micro_cutoff(), 40);
        assert_eq!(
            projected[1].content,
            vec![ContentPart::Text {
                text: MICRO_MARKER.to_string()
            }]
        );
        // The most recent tool results stay verbatim.
        let last = projected.len() - 1;
        assert_eq!(projected[last].text(), "x".repeat(500));
        // User messages are never truncated.
        assert_eq!(projected[0].text(), "question 0");
    }

    #[test]
    fn micro_marks_superseded_reads() {
        let mut messages = vec![Message::assistant(
            vec![],
            vec![ToolCall::new(
                "call_old",
                "Read",
                Some("{\"path\":\"src/lib.rs\"}".to_string()),
            )],
        )];
        messages.push(tool_result_message("call_old", &"y".repeat(500)));
        // A later re-read of the same path.
        messages.push(Message::assistant(
            vec![],
            vec![ToolCall::new(
                "call_new",
                "Read",
                Some("{\"path\":\"src/lib.rs\"}".to_string()),
            )],
        ));
        messages.push(tool_result_message("call_new", &"z".repeat(500)));
        for index in 0..30 {
            messages.push(Message::user(format!("padding {index}")));
        }

        // 500-token window -> micro triggers at 250.
        let mut pipeline = CompactionPipeline::new(500, 100);
        let projected = pipeline.apply_micro(&messages);
        assert_eq!(
            projected[1].text(),
            "[Superseded by a newer read of src/lib.rs]"
        );
    }

    #[test]
    fn micro_is_a_projection_and_history_stays_intact() {
        let messages = vec![
            Message::user("hi"),
            tool_result_message("call_1", &"z".repeat(500)),
        ];
        let mut pipeline = CompactionPipeline::new(1, 1); // tiny window: always triggers
        let _ = pipeline.apply_micro(&messages);
        assert_eq!(
            messages[1].text(),
            "z".repeat(500),
            "input must not be mutated"
        );
    }

    #[test]
    fn full_split_respects_safety_rules() {
        // [user, assistant+tool, tool, assistant(text)] — the only safe split
        // is after the final assistant message.
        let messages = vec![
            Message::user("do work"),
            Message::assistant(
                vec![],
                vec![ToolCall::new("c1", "Read", Some("{}".to_string()))],
            ),
            tool_result_message("c1", "content"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "done".into(),
                }],
                vec![],
            ),
            Message::user("next"),
            Message::assistant(vec![ContentPart::Text { text: "ok".into() }], vec![]),
        ];
        let pipeline = CompactionPipeline::new(100_000, 1_000);
        let split = pipeline.plan_full_split(&messages).unwrap();
        // Splitting after index 2 (the tool result) would orphan it, after
        // index 3 is safe but a later safe point exists; the planner keeps
        // the minimal recent suffix while respecting safety.
        assert!(split >= 1 && split < messages.len(), "split={split}");
        assert!(can_split_after(&messages, split - 1));
        assert_ne!(messages.get(split).map(|m| m.role), Some(Role::Tool));
    }

    #[test]
    fn split_is_unsafe_after_user_or_tool_call_assistant() {
        let messages = vec![
            Message::user("a"),
            Message::assistant(vec![ContentPart::Text { text: "b".into() }], vec![]),
        ];
        assert!(!can_split_after(&messages, 0), "cannot split after user");
        assert!(can_split_after(&messages, 1));

        let with_tools = vec![
            Message::assistant(
                vec![],
                vec![ToolCall::new("c1", "Read", Some("{}".to_string()))],
            ),
            tool_result_message("c1", "x"),
        ];
        assert!(
            !can_split_after(&with_tools, 0),
            "cannot split after an assistant with pending tool calls"
        );
    }

    #[test]
    fn breaker_opens_after_three_failures() {
        let mut pipeline = CompactionPipeline::new(100_000, 1_000);
        assert!(!pipeline.breaker_open());
        pipeline.record_failure();
        pipeline.record_failure();
        assert!(!pipeline.breaker_open());
        pipeline.record_failure();
        assert!(pipeline.breaker_open());
        pipeline.record_success();
        assert!(!pipeline.breaker_open());
    }

    #[test]
    fn thresholds_scale_with_the_window() {
        let pipeline = CompactionPipeline::new(100_000, 1_000);
        assert!(!pipeline.should_compact(74_999));
        assert!(pipeline.should_compact(75_000));
        assert!(!pipeline.should_block(84_999));
        assert!(pipeline.should_block(85_000));
        // Micro triggers at 50% of the window.
        assert!(pipeline.should_micro(50_000));
        assert!(!pipeline.should_micro(49_999));
        // The 200k cap lowers the trigger for huge windows.
        let huge = CompactionPipeline::new(2_000_000, 1_000);
        assert!(huge.should_micro(200_000));
    }

    #[test]
    fn renders_messages_with_headers_and_tool_calls() {
        let messages = vec![
            Message::user("hello"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "using tool".into(),
                }],
                vec![ToolCall::new(
                    "c1",
                    "Read",
                    Some("{\"path\":\"a\"}".to_string()),
                )],
            ),
        ];
        let rendered = render_messages(&messages);
        assert!(rendered.contains("--- message 1 role=user ---"));
        assert!(rendered.contains("--- message 2 role=assistant ---"));
        assert!(rendered.contains("tool calls:"));
        assert!(rendered.contains("c1 Read"));
    }

    #[test]
    fn manual_split_replaces_a_finished_turn_and_rejects_a_single_message() {
        assert!(CompactionPipeline::plan_manual_split(&[Message::user("only")]).is_none());
        let turn = vec![Message::user("hello"), Message::assistant(vec![], vec![])];
        assert_eq!(CompactionPipeline::plan_manual_split(&turn), Some(2));
        let two_turns = vec![
            Message::user("one"),
            Message::assistant(vec![], vec![]),
            Message::user("two"),
            Message::assistant(vec![], vec![]),
        ];
        assert_eq!(CompactionPipeline::plan_manual_split(&two_turns), Some(4));
    }
}
