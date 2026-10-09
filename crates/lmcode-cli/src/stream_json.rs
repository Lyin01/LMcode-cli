//! stream-json prompt-mode output (Claude Code compatible NDJSON).
//!
//! `lm -p "…" --output-format stream-json` prints one JSON event per line on
//! stdout: a `system/init` event, `assistant` message events carrying text /
//! thinking / tool_use content blocks, `user` events carrying tool_result
//! blocks, and a final `result` event. This mirrors the legacy CLI's
//! `run-stream-json` protocol closely enough for cc-connect style consumers.

use std::io::Write;

use lmcode_core::agent::TurnUi;
use serde_json::json;

/// NDJSON UI for `--output-format stream-json`.
pub struct StreamJsonUi {
    pending_text: String,
    pending_thinking: String,
}

impl StreamJsonUi {
    /// Emit the `system/init` event and return the UI.
    pub fn new(session_id: Option<&str>) -> Self {
        write_line(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
        }));
        Self {
            pending_text: String::new(),
            pending_thinking: String::new(),
        }
    }

    fn flush_thinking(&mut self) {
        if self.pending_thinking.is_empty() {
            return;
        }
        let thinking = std::mem::take(&mut self.pending_thinking);
        write_line(&json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "thinking", "thinking": thinking }],
            },
        }));
    }

    fn flush_text(&mut self) {
        if self.pending_text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.pending_text);
        write_line(&json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
            },
        }));
    }

    /// Emit the final `result` event after the turn completes.
    pub fn finish(&mut self, interrupted: bool) {
        self.flush_thinking();
        self.flush_text();
        write_line(&json!({
            "type": "result",
            "subtype": if interrupted { "error" } else { "success" },
            "is_error": interrupted,
            "result": if interrupted { "interrupted" } else { "ok" },
        }));
    }
}

#[async_trait::async_trait]
impl TurnUi for StreamJsonUi {
    async fn text_delta(&mut self, text: &str) {
        self.pending_text.push_str(text);
    }

    async fn think_delta(&mut self, text: &str) {
        self.pending_thinking.push_str(text);
    }

    async fn tool_start(&mut self, name: &str, arguments: &str) {
        self.flush_thinking();
        self.flush_text();
        let input: serde_json::Value =
            serde_json::from_str(arguments).unwrap_or(serde_json::Value::Null);
        write_line(&json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "name": name, "input": input }],
            },
        }));
    }

    async fn tool_end(&mut self, name: &str, ok: bool, result: &str) {
        write_line(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_name": name,
                    "is_error": !ok,
                    "content": result,
                }],
            },
        }));
    }

    async fn approve(&mut self, _name: &str, _arguments: &str) -> bool {
        // Prompt mode is headless: approval is automatic (the legacy CLI
        // forces auto permission with headless approval in prompt mode too).
        true
    }

    async fn notice(&mut self, message: &str) {
        write_line(&json!({
            "type": "system",
            "subtype": "notice",
            "message": message,
        }));
    }
}

fn write_line(value: &serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

/// Options for the hidden `stream-json` sub-command (cc-connect protocol).
pub struct StreamJsonCommand {
    pub resume: Option<String>,
    pub model: Option<String>,
    pub append_system_prompt: Option<String>,
    pub skills_dirs: Vec<std::path::PathBuf>,
}

/// Hidden `lm stream-json` entry point: reads stream-json user messages on
/// stdin, runs a turn per message, and emits NDJSON events on stdout.
pub async fn run_stream_json(command: StreamJsonCommand) -> anyhow::Result<()> {
    use tokio::io::AsyncBufReadExt;

    const SYSTEM_PROMPT: &str = include_str!("system.md");

    let config = lmcode_core::config::load_config(None)?;
    let resolved = lmcode_core::config::resolve_model(&config, command.model.as_deref())?;
    let provider = lmcode_llm::providers::create_provider(resolved.into_provider_config())?;

    let cwd = std::env::current_dir()?;
    let tools: Vec<std::sync::Arc<dyn lmcode_core::tools::Tool>> = vec![
        std::sync::Arc::new(lmcode_core::tools::ReadTool),
        std::sync::Arc::new(lmcode_core::tools::BashTool::new()),
        std::sync::Arc::new(lmcode_core::tools::WriteTool),
        std::sync::Arc::new(lmcode_core::tools::EditTool),
        std::sync::Arc::new(lmcode_core::tools::GrepTool),
        std::sync::Arc::new(lmcode_core::tools::GlobTool),
    ];

    let mut system_prompt = SYSTEM_PROMPT.to_string();
    if let Some(extra) = &command.append_system_prompt {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(extra);
    }
    let skills = if command.skills_dirs.is_empty() {
        lmcode_core::skill::discover_skills(&cwd)
    } else {
        lmcode_core::skill::discover_skills_in(&command.skills_dirs)
    };
    if !skills.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&lmcode_core::skill::render_skill_prompt(&skills));
    }

    let mut agent = lmcode_core::agent::Agent::new(provider, tools, system_prompt, cwd.clone());
    agent.apply_permission_config(&config);
    if let Some(id) = &command.resume {
        let store = lmcode_core::session::SessionStore::new();
        match store.load(&cwd, id) {
            Ok(session) => agent.attach_session(session),
            Err(error) => {
                eprintln!("[stream-json] warning: cannot resume session {id}: {error}");
            }
        }
    }

    let mut ui = StreamJsonUi::new(agent.session_id());
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        match value["type"].as_str() {
            Some("user") => {
                if let Some(text) = extract_user_text(&value)
                    && !text.trim().is_empty()
                {
                    let outcome = agent.run_turn(&text, &mut ui).await?;
                    ui.finish(outcome.interrupted);
                }
            }
            Some("control_request") => {
                let request_id = value["request_id"].clone();
                write_line(&json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": request_id },
                }));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Pull the plain text out of a stream-json `user` message event.
fn extract_user_text(value: &serde_json::Value) -> Option<String> {
    let content = value["message"]["content"].as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for block in content {
        if block["type"].as_str() == Some("text")
            && let Some(text) = block["text"].as_str()
        {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_user_text_handles_all_shapes() {
        // Normal single text block.
        let value = json!({"type":"user","message":{"content":[{"type":"text","text":"hi"}]}});
        assert_eq!(extract_user_text(&value).as_deref(), Some("hi"));

        // Multiple text blocks are joined with newlines.
        let value = json!({"type":"user","message":{"content":[
            {"type":"text","text":"a"}, {"type":"text","text":"b"}
        ]}});
        assert_eq!(extract_user_text(&value).as_deref(), Some("a\nb"));

        // Non-text blocks only → nothing to run.
        let value =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}});
        assert_eq!(extract_user_text(&value), None);

        // Malformed / missing fields never panic.
        assert_eq!(extract_user_text(&json!({"type":"user"})), None);
        assert_eq!(extract_user_text(&json!({})), None);
        assert_eq!(
            extract_user_text(&json!({"message":{"content":"not-an-array"}})),
            None
        );
        assert_eq!(extract_user_text(&json!(null)), None);
    }
}
