//! Desktop bridge: assembles the agent (same wiring as the CLI) and forwards
//! its activity to the frontend as `agent-event` payloads.

use std::sync::Arc;

use async_trait::async_trait;
use lmcode_core::agent::{Agent, TurnUi};
use lmcode_core::config::{load_config, resolve_model};
use lmcode_core::session::SessionStore;
use lmcode_core::tools::{
    BashTool, EditTool, GlobTool, GrepTool, McpToolAdapter, MemoryConsolidateApplyTool,
    MemoryConsolidatePlanTool, MemoryEditTool, MemoryLookupTool, MemoryWriteTool, ReadTool,
    SkillTool, Tool, WriteTool,
};
use lmcode_llm::providers::create_provider;
use lmcode_memory::MemoStore;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, mpsc, oneshot};

const SYSTEM_PROMPT: &str = include_str!("system.md");

/// Commands accepted by the agent worker.
#[derive(Debug)]
pub enum AgentCommand {
    /// Run one prompt turn; `images` are local paths or data URLs attached
    /// to the user message.
    Turn { text: String, images: Vec<String> },
    /// Resume a persisted session by id.
    Resume(String),
    /// Create and attach a fresh session.
    NewSession,
    /// Swap the active model alias (see `[models]` in config.toml).
    SwitchModel(String),
    /// Scheduler tick: deliver due cron fires (may auto-start a turn).
    CronTick,
}

/// Current model/session, readable by the frontend after load (avoids the
/// race where `SessionReady` fires before the webview subscribes).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatusPayload {
    pub model: String,
    pub session: String,
}

/// One `git status --porcelain` entry.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    /// Index (staged) status letter (`M`, `A`, `D`, `?`, …).
    pub index: String,
    /// Worktree status letter.
    pub worktree: String,
}

/// A long-running shell session backing the terminal panel.
pub struct TerminalSession {
    pub stdin: tokio::process::ChildStdin,
    pub child: tokio::process::Child,
}

/// One `git worktree list --porcelain` entry.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    /// Short head commit.
    pub head: String,
    /// Branch name, or `None` when detached.
    pub branch: Option<String>,
    pub bare: bool,
}

/// Parse `git worktree list --porcelain` output.
pub fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut worktrees: Vec<WorktreeInfo> = Vec::new();
    let mut current: Option<(String, String, Option<String>, bool)> = None;
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some((path, head, branch, bare)) = current.take() {
                worktrees.push(WorktreeInfo {
                    path,
                    head,
                    branch,
                    bare,
                });
            }
            current = Some((path.to_string(), String::new(), None, false));
        } else if let Some(entry) = current.as_mut() {
            if let Some(head_value) = line.strip_prefix("HEAD ") {
                entry.1 = head_value.chars().take(8).collect();
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                entry.2 = Some(
                    branch_ref
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch_ref)
                        .to_string(),
                );
            } else if line == "bare" {
                entry.3 = true;
            }
        }
    }
    if let Some((path, head, branch, bare)) = current {
        worktrees.push(WorktreeInfo {
            path,
            head,
            branch,
            bare,
        });
    }
    worktrees
}

/// Parse `git status --porcelain` output (v1, non-z form).
pub fn parse_git_status(output: &str) -> Vec<GitChange> {
    output
        .lines()
        .filter(|line| line.chars().count() >= 4)
        .map(|line| {
            let mut chars = line.chars();
            let index = chars.next().unwrap_or(' ').to_string();
            let worktree = chars.next().unwrap_or(' ').to_string();
            let rest: String = chars.skip(1).collect();
            // Renames read `old -> new`; keep the new path.
            let path = rest
                .split_once(" -> ")
                .map(|(_, new)| new.to_string())
                .unwrap_or(rest);
            GitChange {
                path,
                index,
                worktree,
            }
        })
        .collect()
}

/// Lightweight session list entry for the frontend sidebar.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub model: String,
    pub updated_at: String,
}

impl SessionSummary {
    pub fn from_state(state: &lmcode_core::session::SessionState) -> Self {
        Self {
            id: state.id.clone(),
            title: state.title.clone(),
            model: state.model.clone(),
            updated_at: state.updated_at.clone(),
        }
    }
}

/// One history entry replayed to the frontend after resuming a session.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HistoryMessage {
    pub role: String,
    pub text: String,
}

/// Flatten persisted messages into simple role/text pairs (system prompts are
/// not replayed; empty tool turns are dropped).
pub fn history_view(messages: &[lmcode_llm::message::Message]) -> Vec<HistoryMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                lmcode_llm::message::Role::User => "user",
                lmcode_llm::message::Role::Assistant => "assistant",
                lmcode_llm::message::Role::Tool => "tool",
                lmcode_llm::message::Role::System => return None,
            };
            let text = message.text();
            if text.trim().is_empty() {
                return None;
            }
            Some(HistoryMessage {
                role: role.to_string(),
                text,
            })
        })
        .collect()
}

/// Events forwarded to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DesktopEvent {
    TextDelta {
        text: String,
    },
    ThinkDelta {
        text: String,
    },
    ToolStart {
        name: String,
        arguments: String,
    },
    ToolEnd {
        name: String,
        ok: bool,
        result: String,
    },
    Notice {
        message: String,
    },
    Error {
        message: String,
    },
    ApprovalRequest {
        name: String,
        arguments: String,
    },
    TurnFinished {
        interrupted: bool,
    },
    SessionReady {
        model: String,
        session: String,
    },
}

/// `TurnUi` implementation that forwards everything to the webview.
pub struct DesktopUi {
    handle: AppHandle,
    approval: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    inbox: InboxLog,
    /// Broadcast for the LAN remote service (JSON-encoded events).
    events_tx: tokio::sync::broadcast::Sender<String>,
}

impl DesktopUi {
    fn emit(&self, event: DesktopEvent) {
        self.record(&event);
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = self.events_tx.send(json);
        }
        let _ = self.handle.emit("agent-event", event);
    }

    /// Record notable events in the shared inbox (notification history).
    fn record(&self, event: &DesktopEvent) {
        let (kind, outcome, message) = match event {
            DesktopEvent::TurnFinished { interrupted } => (
                "turn",
                "success",
                if *interrupted {
                    "Turn interrupted".to_string()
                } else {
                    "Turn finished".to_string()
                },
            ),
            DesktopEvent::Error { message } => ("error", "failure", message.clone()),
            DesktopEvent::Notice { message } => {
                if message.starts_with("cron fired") {
                    ("cron", "success", message.clone())
                } else {
                    ("notice", "success", message.clone())
                }
            }
            DesktopEvent::ApprovalRequest { name, .. } => {
                ("approval", "pending", format!("Approval requested: {name}"))
            }
            _ => return,
        };
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let item = InboxItem {
            id: format!("inbox-{counter:x}"),
            kind: kind.to_string(),
            outcome: outcome.to_string(),
            message,
            read: false,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
        };
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.insert(0, item);
            inbox.truncate(100);
        }
    }
}

/// One inbox entry (desktop notification history).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: String,
    pub outcome: String,
    pub message: String,
    pub read: bool,
    pub created_at: u64,
}

/// Shared inbox log.
pub type InboxLog = Arc<std::sync::Mutex<Vec<InboxItem>>>;

#[async_trait]
impl TurnUi for DesktopUi {
    async fn text_delta(&mut self, text: &str) {
        self.emit(DesktopEvent::TextDelta {
            text: text.to_string(),
        });
    }

    async fn think_delta(&mut self, text: &str) {
        self.emit(DesktopEvent::ThinkDelta {
            text: text.to_string(),
        });
    }

    async fn tool_start(&mut self, name: &str, arguments: &str) {
        self.emit(DesktopEvent::ToolStart {
            name: name.to_string(),
            arguments: arguments.to_string(),
        });
    }

    async fn tool_end(&mut self, name: &str, ok: bool, result: &str) {
        self.emit(DesktopEvent::ToolEnd {
            name: name.to_string(),
            ok,
            result: result.to_string(),
        });
    }

    async fn approve(&mut self, name: &str, arguments: &str) -> bool {
        let (respond, response) = oneshot::channel();
        *self.approval.lock().await = Some(respond);
        self.emit(DesktopEvent::ApprovalRequest {
            name: name.to_string(),
            arguments: arguments.to_string(),
        });
        response.await.unwrap_or(false)
    }

    async fn notice(&mut self, message: &str) {
        self.emit(DesktopEvent::Notice {
            message: message.to_string(),
        });
    }
}

/// Assemble the agent and run the command loop until the app closes.
///
/// NOTE: the tool assembly mirrors the CLI entry point; extracting a shared
/// assembler is a later-batch refactor.
/// Shared state the agent worker needs at startup.
pub struct StartupContext {
    pub approval: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    pub status: Arc<Mutex<Option<StatusPayload>>>,
    pub subagents: lmcode_core::subagent::SubagentLog,
    pub inbox: InboxLog,
    pub events_tx: tokio::sync::broadcast::Sender<String>,
}

pub async fn start_agent(
    handle: AppHandle,
    mut commands: mpsc::UnboundedReceiver<AgentCommand>,
    startup: StartupContext,
    initial_message: Option<String>,
) -> anyhow::Result<()> {
    let StartupContext {
        approval,
        status,
        subagents,
        inbox,
        events_tx,
    } = startup;
    let mut ui = DesktopUi {
        handle: handle.clone(),
        approval,
        inbox,
        events_tx,
    };

    let cwd = std::env::current_dir()?;
    let config = load_config(None)?;
    let resolved = resolve_model(&config, None)?;
    let display_name = resolved.display_name.clone();
    let max_context_size = resolved.max_context_size;
    let max_output_size = resolved.max_output_size;
    let embedding_engine: Option<Arc<dyn lmcode_memory::EmbeddingEngine>> =
        Some(Arc::new(lmcode_memory::OpenAiEmbeddingEngine::new(
            resolved.base_url.clone(),
            resolved.api_key.clone(),
            None,
        )));
    let provider = create_provider(resolved.into_provider_config())?;

    let session_store = SessionStore::new();
    let session = match session_store.latest(&cwd)? {
        Some(session) => session,
        None => session_store.create(&cwd, &display_name)?,
    };
    let session_id = session.id().to_string();

    // Background tasks: shared between the Bash tool and TaskOutput.
    let background = Arc::new(lmcode_core::background::BackgroundTaskManager::new(
        lmcode_core::config::lmcode_home().join("tasks"),
    ));

    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(ReadTool),
        Arc::new(BashTool::with_background(Arc::clone(&background))),
        Arc::new(WriteTool),
        Arc::new(EditTool),
        Arc::new(GrepTool),
        Arc::new(GlobTool),
    ];
    let mut memo_store_for_agent = None;
    if let Ok(memo_store) = MemoStore::open(&MemoStore::default_path()) {
        let memo_store = Arc::new(memo_store);
        memo_store_for_agent = Some(Arc::clone(&memo_store));
        tools.push(Arc::new(MemoryLookupTool::new(
            Arc::clone(&memo_store),
            cwd.clone(),
            embedding_engine.clone(),
        )));
        tools.push(Arc::new(MemoryWriteTool::new(
            Arc::clone(&memo_store),
            cwd.clone(),
            session_id.clone(),
            embedding_engine.clone(),
        )));
        tools.push(Arc::new(MemoryEditTool::new(Arc::clone(&memo_store))));
        tools.push(Arc::new(MemoryConsolidatePlanTool::new(Arc::clone(
            &memo_store,
        ))));
        tools.push(Arc::new(MemoryConsolidateApplyTool::new(memo_store)));
    }
    let skills = lmcode_core::skill::discover_skills(&cwd);
    if !skills.is_empty() {
        tools.push(Arc::new(SkillTool::new(skills.clone())));
    }
    if let Ok(servers) = lmcode_mcp::load_servers(&cwd) {
        for (server_name, server_config) in servers {
            let Ok(client) = lmcode_mcp::McpClient::connect(&server_name, &server_config).await
            else {
                continue;
            };
            let client = Arc::new(Mutex::new(client));
            let initialized = {
                let mut guard = client.lock().await;
                guard.initialize().await
            };
            if initialized.is_err() {
                continue;
            }
            let listed = {
                let mut guard = client.lock().await;
                guard.list_tools().await
            };
            if let Ok(definitions) = listed {
                for definition in definitions {
                    let qualified = lmcode_mcp::qualify_tool_name(&server_name, &definition.name);
                    tools.push(Arc::new(McpToolAdapter::new(
                        Arc::clone(&client),
                        server_name.clone(),
                        qualified,
                        definition,
                    )));
                }
            }
        }
    }

    let system_prompt = if skills.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!(
            "{SYSTEM_PROMPT}\n\n{}",
            lmcode_core::skill::render_skill_prompt(&skills)
        )
    };

    // TaskOutput + plan / goal / cron / web / LSP / subagents (mirrors the
    // CLI tool assembly).
    tools.push(Arc::new(
        lmcode_core::tools::task_output::TaskOutputTool::new(Arc::clone(&background)),
    ));
    let plan_handle: lmcode_core::tools::planning::PlanHandle =
        Arc::new(Mutex::new(lmcode_core::plan::PlanMode::default()));
    tools.push(Arc::new(
        lmcode_core::tools::planning::EnterPlanModeTool::new(Arc::clone(&plan_handle)),
    ));
    tools.push(Arc::new(
        lmcode_core::tools::planning::ExitPlanModeTool::new(Arc::clone(&plan_handle)),
    ));
    let goal_handle: lmcode_core::tools::goal::GoalHandle =
        Arc::new(Mutex::new(lmcode_core::goal::GoalMode::with_path(
            lmcode_core::config::lmcode_home()
                .join("goals")
                .join("current.json"),
        )));
    let evidence_snapshot = Arc::new(Mutex::new(String::new()));
    tools.push(Arc::new(lmcode_core::tools::goal::CreateGoalTool::new(
        Arc::clone(&goal_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::goal::GetGoalTool::new(
        Arc::clone(&goal_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::goal::SetGoalBudgetTool::new(
        Arc::clone(&goal_handle),
    )));
    tools.push(Arc::new(
        lmcode_core::tools::goal::UpdateGoalTool::with_grader(
            Arc::clone(&goal_handle),
            lmcode_core::tools::goal::GoalGrader {
                provider: Arc::clone(&provider),
                evidence: Arc::clone(&evidence_snapshot),
            },
        ),
    ));
    tools.push(Arc::new(lmcode_core::tools::goal::WriteGoalNoteTool::new(
        Arc::clone(&goal_handle),
    )));
    let cron_handle: lmcode_core::tools::cron::CronHandle = Arc::new(Mutex::new(
        lmcode_core::cron::CronStore::with_dir(lmcode_core::config::lmcode_home().join("cron")),
    ));
    tools.push(Arc::new(lmcode_core::tools::cron::CronCreateTool::new(
        Arc::clone(&cron_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::cron::CronDeleteTool::new(
        Arc::clone(&cron_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::cron::CronListTool::new(
        Arc::clone(&cron_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::web::FetchUrlTool::new()));
    let lsp_registry = Arc::new(lmcode_core::lsp::LspRegistry::default());
    tools.push(Arc::new(lmcode_core::tools::lsp::LspTool::new(
        lsp_registry,
    )));
    let subagent_runner = Arc::new(
        lmcode_core::subagent::SubagentRunner::new(
            Arc::clone(&provider),
            tools.clone(),
            cwd.clone(),
        )
        .with_log(subagents),
    );
    tools.push(Arc::new(lmcode_core::tools::collaboration::AgentTool::new(
        Arc::clone(&subagent_runner),
    )));
    tools.push(Arc::new(
        lmcode_core::tools::collaboration::WolfPackTool::new(Arc::clone(&subagent_runner)),
    ));

    let mut agent = Agent::new(provider, tools, system_prompt, cwd.clone());
    agent.set_compaction_limits(
        max_context_size.unwrap_or(0),
        max_output_size.unwrap_or(8192),
    );
    agent.attach_session(session);
    if let Some(store) = memo_store_for_agent {
        agent.attach_memo_store(store);
    }
    agent.attach_plan(plan_handle);
    agent.attach_goal(goal_handle);
    agent.attach_cron(cron_handle);
    agent.attach_evidence_snapshot(evidence_snapshot);

    let mut current_model = display_name.clone();
    *status.lock().await = Some(StatusPayload {
        model: display_name.clone(),
        session: session_id.clone(),
    });
    ui.emit(DesktopEvent::SessionReady {
        model: display_name,
        session: session_id,
    });

    if let Some(message) = initial_message {
        let result = agent.run_turn(&message, &mut ui).await;
        let interrupted = result
            .as_ref()
            .map(|outcome| outcome.interrupted)
            .unwrap_or(false);
        if let Err(error) = result {
            ui.emit(DesktopEvent::Error {
                message: error.to_string(),
            });
        }
        ui.emit(DesktopEvent::TurnFinished { interrupted });
    }

    // Cron scheduler tick: deliver due fires every 30 seconds.
    let mut cron_tick = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        let command = tokio::select! {
            command = commands.recv() => match command {
                Some(command) => command,
                None => break,
            },
            _ = cron_tick.tick() => AgentCommand::CronTick,
        };
        match command {
            AgentCommand::Turn { text, images } => {
                let result = agent.run_turn_with_images(&text, &images, &mut ui).await;
                let interrupted = result
                    .as_ref()
                    .map(|outcome| outcome.interrupted)
                    .unwrap_or(false);
                if let Err(error) = result {
                    ui.emit(DesktopEvent::Error {
                        message: error.to_string(),
                    });
                }
                ui.emit(DesktopEvent::TurnFinished { interrupted });
            }
            AgentCommand::Resume(id) => match session_store.load(&cwd, &id) {
                Ok(session) => {
                    agent.attach_session(session);
                    *status.lock().await = Some(StatusPayload {
                        model: current_model.clone(),
                        session: id.clone(),
                    });
                    ui.emit(DesktopEvent::Notice {
                        message: format!("resumed session {id}"),
                    });
                    ui.emit(DesktopEvent::SessionReady {
                        model: current_model.clone(),
                        session: id,
                    });
                }
                Err(error) => {
                    ui.emit(DesktopEvent::Error {
                        message: error.to_string(),
                    });
                }
            },
            AgentCommand::NewSession => match session_store.create(&cwd, &current_model) {
                Ok(session) => {
                    let id = session.id().to_string();
                    agent.attach_session(session);
                    *status.lock().await = Some(StatusPayload {
                        model: current_model.clone(),
                        session: id.clone(),
                    });
                    ui.emit(DesktopEvent::Notice {
                        message: "started a new session".to_string(),
                    });
                    ui.emit(DesktopEvent::SessionReady {
                        model: current_model.clone(),
                        session: id,
                    });
                }
                Err(error) => {
                    ui.emit(DesktopEvent::Error {
                        message: error.to_string(),
                    });
                }
            },
            AgentCommand::SwitchModel(alias) => match switch_model(&alias) {
                Ok(switch) => {
                    agent.set_provider(switch.provider);
                    agent.set_compaction_limits(
                        switch.max_context_size.unwrap_or(0),
                        switch.max_output_size.unwrap_or(8192),
                    );
                    current_model = switch.display_name.clone();
                    let session = agent.session_id().unwrap_or_default().to_string();
                    *status.lock().await = Some(StatusPayload {
                        model: switch.display_name.clone(),
                        session: session.clone(),
                    });
                    ui.emit(DesktopEvent::Notice {
                        message: format!("model switched to {}", switch.display_name),
                    });
                    ui.emit(DesktopEvent::SessionReady {
                        model: switch.display_name,
                        session,
                    });
                }
                Err(error) => {
                    ui.emit(DesktopEvent::Error {
                        message: error.to_string(),
                    });
                }
            },
            AgentCommand::CronTick => {
                // Re-read from disk so tasks created through the IPC surface
                // are picked up immediately.
                let mut store = lmcode_core::cron::CronStore::with_dir(
                    lmcode_core::config::lmcode_home().join("cron"),
                );
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                let fires = store.due_fires(now_ms);
                if !fires.is_empty() {
                    for fire in &fires {
                        agent.queue_injection(lmcode_core::cron::render_cron_fire_xml(fire));
                        ui.emit(DesktopEvent::Notice {
                            message: format!("cron fired: {}", fire.prompt),
                        });
                    }
                    // The worker is serial, so it is idle here: start the
                    // turn so the fired prompt gets handled.
                    let result = agent
                        .run_turn("A scheduled task has fired — handle it.", &mut ui)
                        .await;
                    let interrupted = result
                        .as_ref()
                        .map(|outcome| outcome.interrupted)
                        .unwrap_or(false);
                    if let Err(error) = result {
                        ui.emit(DesktopEvent::Error {
                            message: error.to_string(),
                        });
                    }
                    ui.emit(DesktopEvent::TurnFinished { interrupted });
                }
            }
        }
    }
    agent.extract_memories_on_exit().await;
    Ok(())
}

/// A resolved provider swap for `SwitchModel`.
struct ModelSwitch {
    provider: Arc<dyn lmcode_llm::provider::ChatProvider>,
    display_name: String,
    max_context_size: Option<u64>,
    max_output_size: Option<u64>,
}

/// Resolve and build a provider for `alias` from config.toml.
fn switch_model(alias: &str) -> anyhow::Result<ModelSwitch> {
    let config = load_config(None)?;
    let resolved = resolve_model(&config, Some(alias))?;
    Ok(ModelSwitch {
        provider: create_provider(resolved.clone().into_provider_config())?,
        display_name: resolved.display_name.clone(),
        max_context_size: resolved.max_context_size,
        max_output_size: resolved.max_output_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_status_lines() {
        let output = " M src/main.rs\nM  src/lib.rs\n?? new-file.txt\nR  old.rs -> new-name.rs\nA  staged.rs\n D gone.rs\n";
        let changes = parse_git_status(output);
        assert_eq!(changes.len(), 6);

        assert_eq!(changes[0].path, "src/main.rs");
        assert_eq!(changes[0].index, " ");
        assert_eq!(changes[0].worktree, "M");

        assert_eq!(changes[1].index, "M");
        assert_eq!(changes[1].worktree, " ");

        assert_eq!(changes[2].index, "?");
        assert_eq!(changes[2].worktree, "?");

        // Renames keep the new path.
        assert_eq!(changes[3].path, "new-name.rs");
        assert_eq!(changes[3].index, "R");

        assert_eq!(changes[4].index, "A");
        assert_eq!(changes[5].worktree, "D");

        // Short/garbage lines are ignored.
        assert!(parse_git_status("\nxy\n").is_empty());
    }

    #[test]
    fn parses_worktree_list_entries() {
        let output = "worktree E:/repo\nHEAD abcdef1234567890\nbranch refs/heads/main\n\nworktree E:/repo-feature\nHEAD 1234567890abcdef\ndetached\n";
        let worktrees = parse_worktree_list(output);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].path, "E:/repo");
        assert_eq!(worktrees[0].head, "abcdef12");
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[0].bare);
        assert_eq!(worktrees[1].path, "E:/repo-feature");
        assert_eq!(worktrees[1].branch, None);

        assert!(parse_worktree_list("").is_empty());
    }
}
