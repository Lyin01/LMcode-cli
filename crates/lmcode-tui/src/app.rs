//! TUI application state: transcript, input editor, scrolling, approvals.

use tokio::sync::oneshot;

/// One rendered entry in the conversation transcript.
#[derive(Debug, Clone)]
pub enum TranscriptEntry {
    User(String),
    Assistant {
        text: String,
        thinking: String,
    },
    Tool {
        name: String,
        arguments: String,
        result: Option<ToolResult>,
    },
    Notice(String),
    Error(String),
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub ok: bool,
    /// Truncated view of the tool output, shown under the tool line.
    pub text: String,
}

/// Open `@file` mention popup state.
#[derive(Debug, Clone)]
pub struct MentionState {
    pub candidates: Vec<String>,
    pub selected: usize,
    /// Byte offset of the `@` in the input buffer.
    pub at: usize,
}

/// One MCP server's runtime state for the `/mcp` panel.
#[derive(Debug, Clone)]
pub struct McpServerInfo {
    pub name: String,
    /// `connected` | `disabled` | `failed`
    pub status: String,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

impl McpServerInfo {
    /// Convert a core manager snapshot into the UI view.
    pub fn from_status(status: &lmcode_core::mcp_manager::McpServerStatus) -> Self {
        Self {
            name: status.name.clone(),
            status: match status.status {
                lmcode_core::mcp_manager::McpStatus::Connected => "connected",
                lmcode_core::mcp_manager::McpStatus::Disabled => "disabled",
                lmcode_core::mcp_manager::McpStatus::Failed => "failed",
            }
            .to_string(),
            tools: status.tools.clone(),
            error: status.error.clone(),
        }
    }
}

/// One built-in MCP server recommendation (mirrors the TS panel list).
pub struct McpRecommendation {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// Only offered on macOS.
    pub mac_only: bool,
}

/// Servers offered by the `/mcp` panel when not yet installed.
pub const MCP_RECOMMENDATIONS: &[McpRecommendation] = &[
    McpRecommendation {
        name: "peekaboo",
        display_name: "Peekaboo",
        description: "macOS desktop automation (screenshot/click/type)",
        command: "npx",
        args: &["-y", "@steipete/peekaboo", "mcp"],
        mac_only: true,
    },
    McpRecommendation {
        name: "chrome-devtools",
        display_name: "Chrome DevTools",
        description: "browser automation (navigate/click/screenshot/profiling)",
        command: "npx",
        args: &["-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"],
        mac_only: false,
    },
];

/// One row of the `/mcp` panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpRow {
    /// Index into `mcp_servers`.
    Server(usize),
    /// Index into [`MCP_RECOMMENDATIONS`].
    Recommended(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Generating,
    Interrupted,
}

/// Single-line input editor with history navigation.
#[derive(Debug, Default)]
pub struct InputState {
    buffer: String,
    /// Cursor position as a char index.
    cursor: usize,
    history: Vec<String>,
    history_index: Option<usize>,
    stash: String,
}

impl InputState {
    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn insert(&mut self, character: char) {
        let mut chars: Vec<char> = self.buffer.chars().collect();
        let position = self.cursor.min(chars.len());
        chars.insert(position, character);
        self.buffer = chars.into_iter().collect();
        self.cursor = position + 1;
        self.history_index = None;
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let mut chars: Vec<char> = self.buffer.chars().collect();
        if self.cursor <= chars.len() {
            chars.remove(self.cursor - 1);
            self.cursor -= 1;
        }
        self.buffer = chars.into_iter().collect();
    }

    pub fn delete(&mut self) {
        let mut chars: Vec<char> = self.buffer.chars().collect();
        if self.cursor < chars.len() {
            chars.remove(self.cursor);
        }
        self.buffer = chars.into_iter().collect();
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.buffer.chars().count());
    }

    pub fn move_home(&mut self) {
        self.cursor = 0;
    }

    pub fn move_end(&mut self) {
        self.cursor = self.buffer.chars().count();
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
        self.history_index = None;
    }

    /// Replace the whole buffer and place the cursor at the given char index.
    pub fn set(&mut self, buffer: String, cursor: usize) {
        self.cursor = cursor.min(buffer.chars().count());
        self.buffer = buffer;
        self.history_index = None;
    }

    /// Take the current input, pushing it to history.
    pub fn take(&mut self) -> String {
        let value = std::mem::take(&mut self.buffer);
        self.cursor = 0;
        self.history_index = None;
        self.stash.clear();
        if !value.trim().is_empty() {
            self.history.push(value.clone());
        }
        value
    }

    /// Navigate to the previous history entry.
    pub fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        match self.history_index {
            None => {
                self.stash = self.buffer.clone();
                self.history_index = Some(self.history.len() - 1);
            }
            Some(0) => {}
            Some(index) => self.history_index = Some(index - 1),
        }
        if let Some(index) = self.history_index {
            self.buffer = self.history[index].clone();
            self.cursor = self.buffer.chars().count();
        }
    }

    /// Navigate to the next history entry (or back to the stashed draft).
    pub fn history_next(&mut self) {
        match self.history_index {
            None => {}
            Some(index) if index + 1 < self.history.len() => {
                self.history_index = Some(index + 1);
                self.buffer = self.history[index + 1].clone();
                self.cursor = self.buffer.chars().count();
            }
            Some(_) => {
                self.history_index = None;
                self.buffer = std::mem::take(&mut self.stash);
                self.cursor = self.buffer.chars().count();
            }
        }
    }
}

/// Approval request waiting for a key press.
pub struct PendingApproval {
    pub name: String,
    pub arguments: String,
    pub respond: oneshot::Sender<bool>,
}

/// Full TUI state.
pub struct App {
    pub transcript: Vec<TranscriptEntry>,
    pub input: InputState,
    pub status: Status,
    pub model: String,
    pub session_id: Option<String>,
    pub pending_approval: Option<PendingApproval>,
    pub should_quit: bool,
    /// Scroll offset measured in lines from the bottom (0 = pinned to bottom).
    pub scroll: u16,
    /// Open selector popup, when any.
    pub picker: Option<crate::picker::Picker>,
    /// Open `@file` mention popup, when any.
    pub mention: Option<MentionState>,
    /// MCP servers connected at startup, shown by `/mcp`.
    pub mcp_servers: Vec<McpServerInfo>,
    /// Whether the `/mcp` panel is open.
    pub mcp_panel: bool,
    /// Selected row in the `/mcp` panel.
    pub mcp_selected: usize,
    /// Server name awaiting a second `d` press to uninstall.
    pub mcp_confirm: Option<String>,
    /// Working directory used for mention completion.
    pub cwd: std::path::PathBuf,
    /// Lazily scanned mention candidates.
    mention_files: Option<Vec<String>>,
}

impl App {
    pub fn new(model: String, session_id: Option<String>) -> Self {
        Self {
            transcript: Vec::new(),
            input: InputState::default(),
            status: Status::Idle,
            model,
            session_id,
            pending_approval: None,
            should_quit: false,
            scroll: 0,
            picker: None,
            mention: None,
            mcp_servers: Vec::new(),
            mcp_panel: false,
            mcp_selected: 0,
            mcp_confirm: None,
            cwd: std::path::PathBuf::from("."),
            mention_files: None,
        }
    }

    /// Apply an event from the agent worker.
    pub fn apply_agent_event(&mut self, event: crate::bridge::AgentEvent) {
        use crate::bridge::AgentEvent;
        match event {
            AgentEvent::TextDelta(text) => {
                self.push_assistant_text(&text);
            }
            AgentEvent::ThinkDelta(text) => {
                self.push_assistant_think(&text);
            }
            AgentEvent::ToolStart { name, arguments } => {
                self.transcript.push(TranscriptEntry::Tool {
                    name,
                    arguments,
                    result: None,
                });
            }
            AgentEvent::McpUpdated { servers } => {
                self.mcp_servers = servers;
                if self.mcp_selected >= self.mcp_servers.len() {
                    self.mcp_selected = self.mcp_servers.len().saturating_sub(1);
                }
            }
            AgentEvent::ToolEnd { name, ok, result } => {
                self.complete_tool(&name, ok, &result);
            }
            AgentEvent::Notice(text) => {
                self.transcript.push(TranscriptEntry::Notice(text));
            }
            AgentEvent::Error(text) => {
                self.transcript.push(TranscriptEntry::Error(text));
            }
            AgentEvent::ApprovalRequest {
                name,
                arguments,
                respond,
            } => {
                self.pending_approval = Some(PendingApproval {
                    name,
                    arguments,
                    respond,
                });
            }
            AgentEvent::TurnFinished {
                interrupted,
                hit_step_limit,
            } => {
                self.finalize_assistant();
                self.status = if interrupted {
                    Status::Interrupted
                } else {
                    Status::Idle
                };
                if hit_step_limit {
                    self.transcript
                        .push(TranscriptEntry::Notice("step limit reached".to_string()));
                }
            }
            AgentEvent::SessionReady { model, session } => {
                self.model = model;
                self.session_id = Some(session);
            }
        }
    }

    fn push_assistant_text(&mut self, text: &str) {
        match self.transcript.last_mut() {
            Some(TranscriptEntry::Assistant { text: current, .. }) => current.push_str(text),
            _ => self.transcript.push(TranscriptEntry::Assistant {
                text: text.to_string(),
                thinking: String::new(),
            }),
        }
    }

    fn push_assistant_think(&mut self, text: &str) {
        match self.transcript.last_mut() {
            Some(TranscriptEntry::Assistant { thinking, .. }) => thinking.push_str(text),
            _ => self.transcript.push(TranscriptEntry::Assistant {
                text: String::new(),
                thinking: text.to_string(),
            }),
        }
    }

    fn complete_tool(&mut self, name: &str, ok: bool, text: &str) {
        for entry in self.transcript.iter_mut().rev() {
            if let TranscriptEntry::Tool {
                name: tool_name,
                result,
                ..
            } = entry
                && tool_name == name
                && result.is_none()
            {
                *result = Some(ToolResult {
                    ok,
                    text: text.to_string(),
                });
                return;
            }
        }
    }

    /// Recompute the `@file` mention popup after the input or cursor changed.
    pub fn refresh_mentions(&mut self) {
        self.mention = None;
        let byte_cursor = crate::mentions::char_to_byte(self.input.buffer(), self.input.cursor());
        let Some((at, query)) = crate::mentions::active_mention(self.input.buffer(), byte_cursor)
        else {
            return;
        };
        if self.mention_files.is_none() {
            self.mention_files = Some(crate::mentions::scan_files(&self.cwd));
        }
        let files = self.mention_files.as_deref().unwrap_or(&[]);
        let candidates = crate::mentions::filter_candidates(files, &query, 64);
        if candidates.is_empty() {
            return;
        }
        self.mention = Some(MentionState {
            candidates,
            selected: 0,
            at,
        });
    }

    /// Move the mention selection by `delta` (wrapping).
    pub fn move_mention(&mut self, delta: i64) {
        if let Some(state) = self.mention.as_mut() {
            let len = state.candidates.len() as i64;
            if len > 0 {
                state.selected = ((state.selected as i64 + delta).rem_euclid(len)) as usize;
            }
        }
    }

    /// Apply the selected mention candidate to the input. Returns true when a
    /// candidate was applied.
    pub fn accept_mention(&mut self) -> bool {
        let Some(state) = self.mention.take() else {
            return false;
        };
        let Some(path) = state.candidates.get(state.selected) else {
            return false;
        };
        let byte_cursor = crate::mentions::char_to_byte(self.input.buffer(), self.input.cursor());
        let (text, byte_cursor) =
            crate::mentions::apply_mention(self.input.buffer(), state.at, path, byte_cursor);
        let new_cursor = text[..byte_cursor.min(text.len())].chars().count();
        self.input.set(text, new_cursor);
        true
    }

    /// Rows shown by the `/mcp` panel: installed servers first, then
    /// recommendations that are not installed (mac-only ones only on macOS).
    pub fn mcp_rows(&self) -> Vec<McpRow> {
        let mut rows: Vec<McpRow> = (0..self.mcp_servers.len()).map(McpRow::Server).collect();
        for (index, recommendation) in MCP_RECOMMENDATIONS.iter().enumerate() {
            if recommendation.mac_only && !cfg!(target_os = "macos") {
                continue;
            }
            if self
                .mcp_servers
                .iter()
                .any(|server| server.name == recommendation.name)
            {
                continue;
            }
            rows.push(McpRow::Recommended(index));
        }
        rows
    }

    /// Move the `/mcp` panel selection by `delta` (wrapping).
    pub fn move_mcp_selection(&mut self, delta: i64) {
        let len = self.mcp_rows().len() as i64;
        if len > 0 {
            self.mcp_selected = ((self.mcp_selected as i64 + delta).rem_euclid(len)) as usize;
        }
    }

    /// The row currently selected in the `/mcp` panel.
    pub fn selected_mcp_row(&self) -> Option<McpRow> {
        self.mcp_rows().get(self.mcp_selected).cloned()
    }

    fn finalize_assistant(&mut self) {
        if let Some(TranscriptEntry::Assistant { text, thinking }) = self.transcript.last()
            && text.is_empty()
            && thinking.is_empty()
        {
            self.transcript.pop();
        }
    }

    /// Push a user message locally (echo) before the turn starts.
    pub fn push_user_message(&mut self, text: String) {
        self.transcript.push(TranscriptEntry::User(text));
    }

    /// Push an informational line into the transcript.
    pub fn push_notice(&mut self, message: &str) {
        self.transcript
            .push(TranscriptEntry::Notice(message.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_edits_at_the_cursor() {
        let mut input = InputState::default();
        for character in "helo".chars() {
            input.insert(character);
        }
        input.move_left();
        input.insert('l');
        assert_eq!(input.buffer(), "hello");
        assert_eq!(input.cursor(), 4);

        input.move_home();
        input.delete();
        assert_eq!(input.buffer(), "ello");

        input.move_end();
        input.backspace();
        assert_eq!(input.buffer(), "ell");
    }

    #[test]
    fn history_navigates_and_restores_the_draft() {
        let mut input = InputState::default();
        input.insert('a');
        let _ = input.take();
        input.insert('b');
        let _ = input.take();
        assert_eq!(input.buffer(), "");

        input.insert('d');
        input.history_prev();
        assert_eq!(input.buffer(), "b");
        input.history_prev();
        assert_eq!(input.buffer(), "a");
        input.history_next();
        assert_eq!(input.buffer(), "b");
        input.history_next();
        assert_eq!(input.buffer(), "d", "draft must be restored");
    }

    #[test]
    fn take_skips_blank_input_from_history() {
        let mut input = InputState::default();
        input.insert(' ');
        let value = input.take();
        assert_eq!(value, " ");
        input.history_prev();
        assert_eq!(input.buffer(), "", "blank input is not stored");
    }

    #[test]
    fn transcript_streams_text_into_one_assistant_entry() {
        use crate::bridge::AgentEvent;
        let mut app = App::new("m".to_string(), None);
        app.apply_agent_event(AgentEvent::ThinkDelta("think".into()));
        app.apply_agent_event(AgentEvent::TextDelta("Hel".into()));
        app.apply_agent_event(AgentEvent::TextDelta("lo".into()));
        assert_eq!(app.transcript.len(), 1);
        match &app.transcript[0] {
            TranscriptEntry::Assistant { text, thinking } => {
                assert_eq!(text, "Hello");
                assert_eq!(thinking, "think");
            }
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn mention_popup_completes_selected_file() {
        let root = std::env::temp_dir().join(format!("lmcode-mention-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        let mut app = App::new("m".to_string(), None);
        app.cwd = root.clone();
        for ch in "open @src/ma".chars() {
            app.input.insert(ch);
        }
        app.refresh_mentions();
        let mention = app.mention.as_ref().expect("mention popup");
        assert_eq!(mention.candidates[0], "src/main.rs");
        assert!(app.accept_mention());
        assert_eq!(app.input.buffer(), "open @src/main.rs ");
        assert!(app.mention.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_panel_selection_wraps() {
        let mut app = App::new("m".to_string(), None);
        app.mcp_servers = vec![
            McpServerInfo {
                name: "alpha".to_string(),
                status: "connected".to_string(),
                tools: vec!["mcp__alpha__one".to_string()],
                error: None,
            },
            McpServerInfo {
                name: "beta".to_string(),
                status: "failed".to_string(),
                tools: Vec::new(),
                error: Some("boom".to_string()),
            },
        ];
        // Row count varies by platform (mac-only recommendations); selection
        // wraps over whatever rows exist.
        let rows = app.mcp_rows().len();
        assert!(rows >= 2, "rows: {rows}");
        app.mcp_selected = 0;
        app.move_mcp_selection(-1);
        assert_eq!(app.mcp_selected, rows - 1);
        app.move_mcp_selection(1);
        assert_eq!(app.mcp_selected, 0);
    }

    #[test]
    fn mcp_rows_skip_installed_recommendations() {
        let mut app = App::new("m".to_string(), None);
        app.mcp_servers = vec![McpServerInfo {
            name: "chrome-devtools".to_string(),
            status: "connected".to_string(),
            tools: Vec::new(),
            error: None,
        }];
        let rows = app.mcp_rows();
        assert!(
            !rows.iter().any(|row| matches!(row, McpRow::Recommended(_))
                && MCP_RECOMMENDATIONS[0].name == "chrome-devtools"),
            "installed recommendation must not appear: {rows:?}"
        );
        assert!(rows.iter().any(|row| matches!(row, McpRow::Server(0))));
    }

    #[test]
    fn tool_entries_pair_start_with_end() {
        use crate::bridge::AgentEvent;
        let mut app = App::new("m".to_string(), None);
        app.apply_agent_event(AgentEvent::ToolStart {
            name: "Bash".into(),
            arguments: "{}".into(),
        });
        app.apply_agent_event(AgentEvent::ToolEnd {
            name: "Bash".into(),
            ok: true,
            result: "+added\n-removed".into(),
        });
        match &app.transcript[0] {
            TranscriptEntry::Tool { result, .. } => {
                let result = result.as_ref().unwrap();
                assert!(result.ok);
                assert_eq!(result.text, "+added\n-removed");
            }
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn finished_turn_drops_empty_assistant_bubbles() {
        use crate::bridge::AgentEvent;
        let mut app = App::new("m".to_string(), None);
        app.apply_agent_event(AgentEvent::TextDelta("hi".into()));
        // Force an empty trailing assistant bubble, then finish.
        app.apply_agent_event(AgentEvent::ToolStart {
            name: "Read".into(),
            arguments: "{}".into(),
        });
        app.apply_agent_event(AgentEvent::TextDelta("".into()));
        app.apply_agent_event(AgentEvent::TurnFinished {
            interrupted: false,
            hit_step_limit: false,
        });
        // The empty bubble after the tool entry is dropped; the first stays.
        assert!(matches!(
            app.transcript.last(),
            Some(TranscriptEntry::Tool { .. })
        ));
    }
}
