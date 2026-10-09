//! Session running notes: tracks tool executions and errors so a brief
//! summary can be injected each turn, preventing the model from losing its
//! bearings when detailed history is compressed away
//! (mirrors `agent/session-memory.ts`).

const MAX_EVENTS: usize = 50;
const MAX_SUMMARY_LENGTH: usize = 1500;
const MAX_RECENT_EVENTS: usize = 15;
const MAX_LISTED_TOOLS: usize = 10;

#[derive(Debug, Clone)]
enum SessionEvent {
    ToolExecution {
        tool_name: String,
        args_summary: String,
        is_error: bool,
        sequence: u64,
    },
    Error {
        message: String,
        sequence: u64,
    },
}

impl SessionEvent {
    fn sequence(&self) -> u64 {
        match self {
            Self::ToolExecution { sequence, .. } | Self::Error { sequence, .. } => *sequence,
        }
    }
}

/// In-memory session running notes.
#[derive(Debug)]
pub struct SessionMemory {
    events: Vec<SessionEvent>,
    next_sequence: u64,
    last_injected_sequence: i64,
}

impl Default for SessionMemory {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            next_sequence: 0,
            // -1 so the first event (sequence 0) counts as new.
            last_injected_sequence: -1,
        }
    }
}

impl SessionMemory {
    /// Record a tool execution (success or failure).
    pub fn record_tool_execution(&mut self, tool_name: &str, args_summary: &str, is_error: bool) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.events.push(SessionEvent::ToolExecution {
            tool_name: tool_name.to_string(),
            args_summary: args_summary.to_string(),
            is_error,
            sequence,
        });
        if self.events.len() > MAX_EVENTS {
            let excess = self.events.len() - MAX_EVENTS;
            self.events.drain(..excess);
        }
    }

    /// Record a session-level error.
    pub fn record_error(&mut self, message: &str) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.events.push(SessionEvent::Error {
            message: message.to_string(),
            sequence,
        });
        if self.events.len() > MAX_EVENTS {
            let excess = self.events.len() - MAX_EVENTS;
            self.events.drain(..excess);
        }
    }

    /// Build a markdown summary of activity since the last injection
    /// (empty when nothing new happened).
    pub fn summary(&mut self) -> String {
        let new_events: Vec<&SessionEvent> = self
            .events
            .iter()
            .filter(|event| event.sequence() as i64 > self.last_injected_sequence)
            .collect();
        if new_events.is_empty() {
            return String::new();
        }
        if let Some(last) = self.events.last() {
            self.last_injected_sequence = last.sequence() as i64;
        }

        let recent: Vec<&SessionEvent> = new_events
            .iter()
            .rev()
            .take(MAX_RECENT_EVENTS)
            .rev()
            .copied()
            .collect();
        let mut tool_lines: Vec<String> = Vec::new();
        let mut error_lines: Vec<String> = Vec::new();
        for event in &recent {
            match event {
                SessionEvent::ToolExecution {
                    tool_name,
                    args_summary,
                    is_error,
                    ..
                } => {
                    let status = if *is_error { "❌ 失败" } else { "✅" };
                    let detail = if args_summary.is_empty() {
                        String::new()
                    } else {
                        format!(" — {args_summary}")
                    };
                    tool_lines.push(format!("- {status} {tool_name}{detail}"));
                }
                SessionEvent::Error { message, .. } => {
                    error_lines.push(format!("- {message}"));
                }
            }
        }
        if tool_lines.is_empty() && error_lines.is_empty() {
            return String::new();
        }

        let mut lines: Vec<String> = vec!["## 当前会话状态".to_string(), String::new()];
        if !error_lines.is_empty() {
            lines.push("### 最近错误".to_string());
            lines.push(String::new());
            lines.extend(error_lines.iter().cloned());
            lines.push(String::new());
        }
        if !tool_lines.is_empty() {
            lines.push("### 最近操作".to_string());
            lines.push(String::new());
            // Keep the most recent entries, in chronological order.
            let listed: Vec<&String> = tool_lines
                .iter()
                .rev()
                .take(MAX_LISTED_TOOLS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            lines.extend(listed.into_iter().cloned());
            lines.push(String::new());
        }

        let joined = lines.join("\n");
        if joined.chars().count() > MAX_SUMMARY_LENGTH {
            let truncated: String = joined.chars().take(MAX_SUMMARY_LENGTH - 3).collect();
            format!("{truncated}...")
        } else {
            joined
        }
    }

    /// Reset for a new session.
    pub fn clear(&mut self) {
        self.events.clear();
        self.next_sequence = 0;
        self.last_injected_sequence = -1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_covers_new_events_once() {
        let mut memory = SessionMemory::default();
        memory.record_tool_execution("Read", "src/main.rs", false);
        memory.record_tool_execution("Bash", "cargo test", true);
        memory.record_error("provider timeout");

        let summary = memory.summary();
        assert!(summary.contains("## 当前会话状态"), "{summary}");
        assert!(summary.contains("### 最近错误"), "{summary}");
        assert!(summary.contains("- provider timeout"), "{summary}");
        assert!(summary.contains("✅ Read — src/main.rs"), "{summary}");
        assert!(summary.contains("❌ 失败 Bash — cargo test"), "{summary}");

        // A second call with no new events is empty.
        assert!(memory.summary().is_empty());

        // New events appear again.
        memory.record_tool_execution("Write", "src/lib.rs", false);
        let summary = memory.summary();
        assert!(summary.contains("Write"), "{summary}");
        assert!(!summary.contains("provider timeout"), "{summary}");
    }

    #[test]
    fn events_are_bounded_and_clear_resets() {
        let mut memory = SessionMemory::default();
        for index in 0..(MAX_EVENTS + 20) {
            memory.record_tool_execution("Read", &format!("file-{index}"), false);
        }
        assert_eq!(memory.events.len(), MAX_EVENTS);

        memory.clear();
        assert!(memory.events.is_empty());
        assert_eq!(memory.next_sequence, 0);
        assert!(memory.summary().is_empty());
    }

    #[test]
    fn long_summaries_are_truncated() {
        let mut memory = SessionMemory::default();
        for _ in 0..MAX_RECENT_EVENTS {
            memory.record_tool_execution("Bash", &"x".repeat(200), false);
        }
        let summary = memory.summary();
        assert!(
            summary.chars().count() <= MAX_SUMMARY_LENGTH,
            "{}",
            summary.chars().count()
        );
    }
}
