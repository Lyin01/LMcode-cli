//! Subagents: same-process agent instances with their own context, used by
//! the `Agent` and `WolfPack` tools (mirrors the TS collaboration tools).

use std::path::PathBuf;
use std::sync::Arc;

use lmcode_llm::message::Role;
use lmcode_llm::provider::ChatProvider;

use crate::agent::{Agent, TurnUi};
use crate::tools::Tool;

/// Profile of a subagent (mirrors the "Available agent types" list).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentProfile {
    Coder,
    Explore,
    Plan,
    Verify,
    Writer,
}

impl SubagentProfile {
    /// Parse a profile name; unknown names fall back to `coder` (the TS tool
    /// default).
    pub fn from_name(name: &str) -> Self {
        match name {
            "explore" => Self::Explore,
            "plan" => Self::Plan,
            "verify" => Self::Verify,
            "writer" => Self::Writer,
            _ => Self::Coder,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Coder => "coder",
            Self::Explore => "explore",
            Self::Plan => "plan",
            Self::Verify => "verify",
            Self::Writer => "writer",
        }
    }

    fn instructions(self) -> &'static str {
        match self {
            Self::Coder => {
                "You are a general software engineering subagent: read files, edit code, run \
                 commands, and return a compact but technically complete summary."
            }
            Self::Explore => {
                "You are a fast read-only exploration subagent. Search the codebase and answer \
                 the question with file paths and findings. You cannot edit files."
            }
            Self::Plan => {
                "You are a read-only planning subagent. Analyze the codebase and produce a \
                 step-by-step implementation plan with key files and trade-offs. You cannot \
                 edit files."
            }
            Self::Verify => {
                "You are a verification subagent. Run build, test, and lint commands and report \
                 the results with exact output evidence. Prefer running commands over reading \
                 code."
            }
            Self::Writer => {
                "You are a content subagent. Produce structured, data-driven Markdown documents \
                 with precise tables when asked."
            }
        }
    }

    /// Whether the profile may use a given tool (collaboration tools are
    /// never available inside a subagent — no recursive delegation).
    pub fn allows(self, tool: &dyn Tool) -> bool {
        if tool.name() == "Agent" || tool.name() == "WolfPack" {
            return false;
        }
        match self {
            Self::Explore | Self::Plan => tool.read_only(),
            Self::Verify => tool.read_only() || tool.name() == "Bash",
            Self::Coder | Self::Writer => true,
        }
    }

    fn max_steps(self) -> usize {
        match self {
            Self::Explore => 20,
            Self::Plan => 20,
            Self::Verify => 30,
            Self::Coder => 50,
            Self::Writer => 30,
        }
    }
}

/// A [`TurnUi`] that discards every event (subagents are headless).
pub struct NullUi;

#[async_trait::async_trait]
impl TurnUi for NullUi {
    async fn text_delta(&mut self, _text: &str) {}
    async fn think_delta(&mut self, _text: &str) {}
    async fn tool_start(&mut self, _name: &str, _arguments: &str) {}
    async fn tool_end(&mut self, _name: &str, _ok: bool, _result: &str) {}
    /// Subagents run without interactive approvals; the sensitive-path hard
    /// boundary in the agent loop still applies.
    async fn approve(&mut self, _name: &str, _arguments: &str) -> bool {
        true
    }
    async fn notice(&mut self, _message: &str) {}
}

/// One subagent run, tracked for UI surfaces (desktop subagent panel).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    pub id: String,
    pub profile: String,
    pub prompt_summary: String,
    /// `running` | `done` | `failed`.
    pub status: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

/// Shared run log (most recent first, capped).
pub type SubagentLog = Arc<std::sync::Mutex<Vec<SubagentRun>>>;

/// Maximum runs kept in the shared log.
const MAX_LOGGED_RUNS: usize = 50;

fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub struct SubagentRunner {
    provider: Arc<dyn ChatProvider>,
    tools: Vec<Arc<dyn Tool>>,
    cwd: PathBuf,
    /// Optional shared log of runs (used by the desktop subagent panel).
    log: Option<SubagentLog>,
}

impl SubagentRunner {
    pub fn new(provider: Arc<dyn ChatProvider>, tools: Vec<Arc<dyn Tool>>, cwd: PathBuf) -> Self {
        Self {
            provider,
            tools,
            cwd,
            log: None,
        }
    }

    /// Attach a shared run log so UI surfaces can show subagent activity.
    pub fn with_log(mut self, log: SubagentLog) -> Self {
        self.log = Some(log);
        self
    }

    /// Record a new run and return its id (no-op without a log).
    fn begin_run(&self, profile: SubagentProfile, prompt: &str) -> Option<String> {
        let log = self.log.as_ref()?;
        let id = {
            // A counter keeps parallel WolfPack runs distinct within the
            // same second.
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            format!("sub-{:08x}-{counter:x}", now_secs() as u32)
        };
        let summary: String = prompt.chars().take(120).collect();
        let run = SubagentRun {
            id: id.clone(),
            profile: profile.name().to_string(),
            prompt_summary: summary,
            status: "running".to_string(),
            started_at: now_secs(),
            finished_at: None,
        };
        let mut runs = log.lock().expect("subagent log lock");
        runs.insert(0, run);
        runs.truncate(MAX_LOGGED_RUNS);
        Some(id)
    }

    /// Finalize a run in the shared log.
    fn finish_run(&self, id: Option<&str>, ok: bool) {
        let (Some(log), Some(id)) = (self.log.as_ref(), id) else {
            return;
        };
        let mut runs = log.lock().expect("subagent log lock");
        if let Some(run) = runs.iter_mut().find(|run| run.id == id) {
            run.status = if ok { "done" } else { "failed" }.to_string();
            run.finished_at = Some(now_secs());
        }
    }

    /// Run one subagent to completion and return its final text.
    pub async fn run(&self, profile: SubagentProfile, prompt: &str) -> Result<String, String> {
        let run_id = self.begin_run(profile, prompt);
        let tools: Vec<Arc<dyn Tool>> = self
            .tools
            .iter()
            .filter(|tool| profile.allows(tool.as_ref()))
            .cloned()
            .collect();
        let system_prompt = format!(
            "You are a `{}` subagent working in {}.\n{}\n\nComplete the task, then reply with \
             a concise final report.",
            profile.name(),
            self.cwd.display(),
            profile.instructions()
        );
        let mut agent = Agent::new(
            Arc::clone(&self.provider),
            tools,
            system_prompt,
            self.cwd.clone(),
        );
        agent.set_max_steps(profile.max_steps());
        let mut ui = NullUi;
        let result = agent.run_turn(prompt, &mut ui).await;
        self.finish_run(run_id.as_deref(), result.is_ok());
        result.map_err(|error| error.to_string())?;
        Ok(final_assistant_text(&agent))
    }
}

/// Last non-empty assistant text in the subagent's history.
fn final_assistant_text(agent: &Agent) -> String {
    agent
        .history()
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant && !message.text().trim().is_empty())
        .map(|message| message.text())
        .unwrap_or_else(|| "(subagent produced no text output)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::{Value, json};

    struct FakeTool {
        name: &'static str,
        read_only: bool,
    }

    #[async_trait]
    impl Tool for FakeTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "fake"
        }
        fn parameters_schema(&self) -> Value {
            json!({ "type": "object" })
        }
        fn read_only(&self) -> bool {
            self.read_only
        }
        async fn execute(&self, _args: &Value, _cwd: &std::path::Path) -> Result<String, String> {
            Ok(String::new())
        }
    }

    #[test]
    fn profiles_filter_tools() {
        let read = FakeTool {
            name: "Read",
            read_only: true,
        };
        let bash = FakeTool {
            name: "Bash",
            read_only: false,
        };
        let write = FakeTool {
            name: "Write",
            read_only: false,
        };
        let agent = FakeTool {
            name: "Agent",
            read_only: true,
        };

        assert!(SubagentProfile::Explore.allows(&read));
        assert!(!SubagentProfile::Explore.allows(&bash));
        assert!(!SubagentProfile::Explore.allows(&write));
        // Verify may also run commands.
        assert!(SubagentProfile::Verify.allows(&bash));
        assert!(!SubagentProfile::Verify.allows(&write));
        // Coder gets everything except collaboration tools.
        assert!(SubagentProfile::Coder.allows(&write));
        assert!(!SubagentProfile::Coder.allows(&agent));
        assert!(!SubagentProfile::Explore.allows(&agent));
    }

    #[test]
    fn profile_names_round_trip_with_coder_default() {
        assert_eq!(
            SubagentProfile::from_name("explore"),
            SubagentProfile::Explore
        );
        assert_eq!(SubagentProfile::from_name("plan"), SubagentProfile::Plan);
        assert_eq!(
            SubagentProfile::from_name("verify"),
            SubagentProfile::Verify
        );
        assert_eq!(
            SubagentProfile::from_name("writer"),
            SubagentProfile::Writer
        );
        assert_eq!(SubagentProfile::from_name("coder"), SubagentProfile::Coder);
        assert_eq!(
            SubagentProfile::from_name("unknown"),
            SubagentProfile::Coder
        );
        assert_eq!(SubagentProfile::Explore.name(), "explore");
    }
}
