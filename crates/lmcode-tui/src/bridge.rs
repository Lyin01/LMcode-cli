//! Bridge between the agent worker task and the TUI event loop.
//!
//! The agent runs in its own tokio task; the TUI communicates with it through
//! two channels: commands in, events out. Approval requests travel with a
//! oneshot responder so the event loop can answer them from a key press.

use std::sync::Arc;

use async_trait::async_trait;
use lmcode_core::agent::{Agent, TurnUi};
use tokio::sync::{mpsc, oneshot};

/// Events flowing from the agent worker to the TUI.
#[derive(Debug)]
pub enum AgentEvent {
    TextDelta(String),
    ThinkDelta(String),
    ToolStart {
        name: String,
        arguments: String,
    },
    ToolEnd {
        name: String,
        ok: bool,
        result: String,
    },
    Notice(String),
    Error(String),
    ApprovalRequest {
        name: String,
        arguments: String,
        respond: oneshot::Sender<bool>,
    },
    TurnFinished {
        interrupted: bool,
        hit_step_limit: bool,
    },
    /// Model/session changed (startup or a switch command).
    SessionReady {
        model: String,
        session: String,
    },
    /// MCP server states changed (toggle or reconnect).
    McpUpdated {
        servers: Vec<crate::app::McpServerInfo>,
    },
}

/// Commands flowing from the TUI to the agent worker.
#[derive(Debug)]
pub enum AgentCommand {
    /// Run one user turn.
    Turn(String),
    /// Drop the conversation history.
    Clear,
    /// Switch to another model alias from config.toml.
    SwitchModel(String),
    /// Resume another session by id.
    SwitchSession(String),
    /// Enable/disable an MCP server from the `/mcp` panel.
    McpToggle(String),
    /// Report the session usage snapshot.
    Usage,
    /// Remove a server definition from its config file.
    McpUninstall(String),
    /// Install a recommended server into the user config.
    McpInstall(String),
    /// Scheduler tick: deliver due cron fires (may auto-start a turn).
    CronTick,
}

/// `TurnUi` implementation that forwards everything to the TUI channel.
pub struct TuiBridge {
    tx: mpsc::UnboundedSender<AgentEvent>,
}

impl TuiBridge {
    pub fn new(tx: mpsc::UnboundedSender<AgentEvent>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl TurnUi for TuiBridge {
    async fn text_delta(&mut self, text: &str) {
        let _ = self.tx.send(AgentEvent::TextDelta(text.to_string()));
    }

    async fn think_delta(&mut self, text: &str) {
        let _ = self.tx.send(AgentEvent::ThinkDelta(text.to_string()));
    }

    async fn tool_start(&mut self, name: &str, arguments: &str) {
        let _ = self.tx.send(AgentEvent::ToolStart {
            name: name.to_string(),
            arguments: arguments.to_string(),
        });
    }

    async fn tool_end(&mut self, name: &str, ok: bool, result: &str) {
        let _ = self.tx.send(AgentEvent::ToolEnd {
            name: name.to_string(),
            ok,
            result: result.to_string(),
        });
    }

    async fn approve(&mut self, name: &str, arguments: &str) -> bool {
        let (respond, response) = oneshot::channel();
        let sent = self.tx.send(AgentEvent::ApprovalRequest {
            name: name.to_string(),
            arguments: arguments.to_string(),
            respond,
        });
        if sent.is_err() {
            return false;
        }
        // Deny when the UI goes away before answering.
        response.await.unwrap_or(false)
    }

    async fn notice(&mut self, message: &str) {
        let _ = self.tx.send(AgentEvent::Notice(message.to_string()));
    }
}

/// Spawn the agent worker task.
pub fn spawn_agent_worker(
    mut agent: Agent,
    mut commands: mpsc::UnboundedReceiver<AgentCommand>,
    events: mpsc::UnboundedSender<AgentEvent>,
    display_name: String,
    mut mcp: lmcode_core::mcp_manager::McpManager,
) {
    tokio::spawn(async move {
        let mut bridge = TuiBridge::new(events.clone());
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let session_store = lmcode_core::session::SessionStore::new();
        let mut current_model = display_name;
        while let Some(command) = commands.recv().await {
            match command {
                AgentCommand::Turn(input) => {
                    let result = agent.run_turn(&input, &mut bridge).await;
                    let (interrupted, hit_step_limit) = match &result {
                        Ok(outcome) => (outcome.interrupted, outcome.hit_step_limit),
                        Err(_) => (false, false),
                    };
                    if let Err(error) = result {
                        let _ = events.send(AgentEvent::Error(error.to_string()));
                    }
                    let _ = events.send(AgentEvent::TurnFinished {
                        interrupted,
                        hit_step_limit,
                    });
                }
                AgentCommand::Clear => {
                    agent.clear_history();
                    let _ = events.send(AgentEvent::Notice("history cleared".to_string()));
                }
                AgentCommand::SwitchModel(alias) => match switch_model(&alias) {
                    Ok(switch) => {
                        agent.set_provider(switch.provider);
                        agent.set_compaction_limits(
                            switch.max_context_size.unwrap_or(0),
                            switch.max_output_size.unwrap_or(8192),
                        );
                        current_model = switch.display_name.clone();
                        let _ = events.send(AgentEvent::Notice(format!(
                            "model switched to {}",
                            switch.display_name
                        )));
                        let _ = events.send(AgentEvent::SessionReady {
                            model: switch.display_name,
                            session: agent.session_id().unwrap_or_default().to_string(),
                        });
                    }
                    Err(error) => {
                        let _ = events.send(AgentEvent::Error(error.to_string()));
                    }
                },
                AgentCommand::SwitchSession(id) => match session_store.load(&cwd, &id) {
                    Ok(session) => {
                        agent.attach_session(session);
                        let _ = events.send(AgentEvent::Notice(format!("resumed session {id}")));
                        let _ = events.send(AgentEvent::SessionReady {
                            model: current_model.clone(),
                            session: id,
                        });
                    }
                    Err(error) => {
                        let _ = events.send(AgentEvent::Error(error.to_string()));
                    }
                },
                AgentCommand::McpToggle(name) => {
                    let prefix = format!("mcp__{name}__");
                    let connected = agent
                        .tool_names()
                        .iter()
                        .any(|tool| tool.starts_with(&prefix));
                    let outcome = if connected {
                        match mcp.disable(&name).await {
                            Ok(()) => {
                                agent.remove_tools_by_prefix(&prefix);
                                Ok(format!("{name} disabled"))
                            }
                            Err(error) => Err(error.to_string()),
                        }
                    } else {
                        match mcp.enable(&name).await {
                            Ok(tools) => {
                                let count = tools.len();
                                agent.extend_tools(tools);
                                Ok(format!("{name} enabled · {count} tool(s)"))
                            }
                            Err(error) => Err(error.to_string()),
                        }
                    };
                    match outcome {
                        Ok(message) => {
                            let _ = events.send(AgentEvent::Notice(message));
                        }
                        Err(message) => {
                            let _ = events.send(AgentEvent::Error(message));
                        }
                    }
                    let servers = mcp
                        .statuses()
                        .iter()
                        .map(crate::app::McpServerInfo::from_status)
                        .collect();
                    let _ = events.send(AgentEvent::McpUpdated { servers });
                }
                AgentCommand::McpUninstall(name) => {
                    let prefix = format!("mcp__{name}__");
                    match mcp.uninstall(&name).await {
                        Ok(path) => {
                            agent.remove_tools_by_prefix(&prefix);
                            let _ = events.send(AgentEvent::Notice(format!(
                                "uninstalled {name} from {}",
                                path.display()
                            )));
                        }
                        Err(error) => {
                            let _ = events.send(AgentEvent::Error(error.to_string()));
                        }
                    }
                    emit_mcp_status(&events, &mcp);
                }
                AgentCommand::McpInstall(name) => {
                    match crate::app::MCP_RECOMMENDATIONS
                        .iter()
                        .find(|recommendation| recommendation.name == name)
                    {
                        Some(recommendation) => {
                            let config = serde_json::json!({
                                "command": recommendation.command,
                                "args": recommendation.args,
                            });
                            match mcp.install(&name, &config).await {
                                Ok(()) => {
                                    let tools = mcp.tools_for(&name);
                                    let count = tools.len();
                                    agent.extend_tools(tools);
                                    let _ = events.send(AgentEvent::Notice(format!(
                                        "installed {name} · {count} tool(s)"
                                    )));
                                }
                                Err(error) => {
                                    let _ = events.send(AgentEvent::Error(error.to_string()));
                                }
                            }
                        }
                        None => {
                            let _ = events.send(AgentEvent::Error(format!(
                                "unknown MCP recommendation `{name}`"
                            )));
                        }
                    }
                    emit_mcp_status(&events, &mcp);
                }
                AgentCommand::Usage => {
                    let snapshot = agent.usage();
                    let mut message = format!(
                        "usage: {} in · {} out tokens",
                        snapshot.total.input_tokens, snapshot.total.output_tokens
                    );
                    if let Some(cache_read) = snapshot.total.cache_read_tokens {
                        message.push_str(&format!(" · {cache_read} cached"));
                    }
                    message.push_str(&format!(
                        " · {} LLM steps · {} tool calls · {} compactions",
                        snapshot.llm_steps, snapshot.tool_calls, snapshot.compactions
                    ));
                    if let Some(top) = snapshot.top_tools.first() {
                        message.push_str(&format!(" · top tool: {} ×{}", top.name, top.calls));
                    }
                    let _ = events.send(AgentEvent::Notice(message));
                }
                AgentCommand::CronTick => {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0);
                    let fires = agent.cron_handle().lock().await.due_fires(now_ms);
                    if !fires.is_empty() {
                        for fire in &fires {
                            agent.queue_injection(lmcode_core::cron::render_cron_fire_xml(fire));
                            let _ = events
                                .send(AgentEvent::Notice(format!("cron fired: {}", fire.prompt)));
                        }
                        // The worker is serial, so it is idle here: start the
                        // turn so the fired prompt gets handled.
                        let result = agent
                            .run_turn("A scheduled task has fired — handle it.", &mut bridge)
                            .await;
                        let (interrupted, hit_step_limit) = match &result {
                            Ok(outcome) => (outcome.interrupted, outcome.hit_step_limit),
                            Err(_) => (false, false),
                        };
                        if let Err(error) = result {
                            let _ = events.send(AgentEvent::Error(error.to_string()));
                        }
                        let _ = events.send(AgentEvent::TurnFinished {
                            interrupted,
                            hit_step_limit,
                        });
                    }
                }
            }
        }
        agent.extract_memories_on_exit().await;
    });
}

/// Broadcast the current MCP server snapshot to the UI.
fn emit_mcp_status(
    events: &mpsc::UnboundedSender<AgentEvent>,
    mcp: &lmcode_core::mcp_manager::McpManager,
) {
    let servers = mcp
        .statuses()
        .iter()
        .map(crate::app::McpServerInfo::from_status)
        .collect();
    let _ = events.send(AgentEvent::McpUpdated { servers });
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
    let config = lmcode_core::config::load_config(None)?;
    let resolved = lmcode_core::config::resolve_model(&config, Some(alias))?;
    Ok(ModelSwitch {
        provider: lmcode_llm::providers::create_provider(resolved.clone().into_provider_config())?,
        display_name: resolved.display_name.clone(),
        max_context_size: resolved.max_context_size,
        max_output_size: resolved.max_output_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn bridge() -> (TuiBridge, mpsc::UnboundedReceiver<AgentEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (TuiBridge::new(tx), rx)
    }

    #[tokio::test]
    async fn deltas_and_tools_forward_to_the_channel() {
        let (mut bridge, mut rx) = bridge();
        bridge.text_delta("hello").await;
        bridge.think_delta("hmm").await;
        bridge.tool_start("Read", "{\"path\":\"a\"}").await;
        bridge.tool_end("Read", true, "ok").await;
        bridge.notice("note").await;

        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        assert_eq!(events.len(), 5);
        assert!(matches!(&events[0], AgentEvent::TextDelta(t) if t == "hello"));
        assert!(matches!(&events[1], AgentEvent::ThinkDelta(t) if t == "hmm"));
        match &events[2] {
            AgentEvent::ToolStart { name, arguments } => {
                assert_eq!(name, "Read");
                assert!(arguments.contains("path"));
            }
            other => panic!("expected ToolStart, got {other:?}"),
        }
        match &events[3] {
            AgentEvent::ToolEnd { name, ok, result } => {
                assert_eq!(name, "Read");
                assert!(*ok);
                assert_eq!(result, "ok");
            }
            other => panic!("expected ToolEnd, got {other:?}"),
        }
        assert!(matches!(&events[4], AgentEvent::Notice(t) if t == "note"));
    }

    #[tokio::test]
    async fn approve_round_trips_through_the_ui() {
        let (mut bridge, mut rx) = bridge();
        let responder = tokio::spawn(async move {
            match rx.recv().await {
                Some(AgentEvent::ApprovalRequest { name, respond, .. }) => {
                    assert_eq!(name, "Bash");
                    let _ = respond.send(true);
                }
                other => panic!("expected ApprovalRequest, got {other:?}"),
            }
        });
        let approved = bridge.approve("Bash", "{\"command\":\"ls\"}").await;
        assert!(approved);
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn approve_denies_when_the_request_is_dropped_without_an_answer() {
        let (mut bridge, mut rx) = bridge();
        let responder = tokio::spawn(async move {
            if let Some(AgentEvent::ApprovalRequest { .. }) = rx.recv().await {
                // Drop `respond` unanswered — the oneshot closes.
            }
        });
        assert!(!bridge.approve("Bash", "{}").await);
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn approve_denies_when_the_channel_is_gone() {
        let (mut bridge, rx) = bridge();
        drop(rx);
        assert!(!bridge.approve("Bash", "{}").await);
    }
}
