//! LMcode terminal UI — a ratatui front end for the agent loop.
//!
//! The agent runs in its own tokio task ([`bridge::spawn_agent_worker`]); this
//! crate owns the terminal: event loop, rendering, and key handling.

pub mod app;
pub mod bridge;
pub mod commands;
pub mod diff;
pub mod markdown;
pub mod mentions;
pub mod picker;
pub mod render;

use std::sync::Arc;

use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use lmcode_core::agent::Agent;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tokio::sync::{Notify, mpsc};

use app::{App, MCP_RECOMMENDATIONS, McpRow, Status};
use bridge::{AgentCommand, AgentEvent, spawn_agent_worker};
use commands::SlashCommand;
use picker::{Picker, PickerItem, PickerKind};

/// Run the full-screen TUI until the user quits.
///
/// The terminal is restored on every exit path.
pub async fn run(
    mut agent: Agent,
    model: String,
    session_id: Option<String>,
    mcp: lmcode_core::mcp_manager::McpManager,
) -> Result<()> {
    let cancel = Arc::new(Notify::new());
    agent.set_cancel_signal(Arc::clone(&cancel));

    let mut terminal = ratatui::init();
    let result = run_loop(&mut terminal, agent, model, session_id, cancel, mcp).await;
    ratatui::restore();
    result
}

async fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    agent: Agent,
    model: String,
    session_id: Option<String>,
    cancel: Arc<Notify>,
    mcp: lmcode_core::mcp_manager::McpManager,
) -> Result<()> {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let (command_tx, command_rx) = mpsc::unbounded_channel::<AgentCommand>();
    let cwd = agent.cwd().to_path_buf();
    let mcp_servers: Vec<app::McpServerInfo> = mcp
        .statuses()
        .iter()
        .map(app::McpServerInfo::from_status)
        .collect();
    spawn_agent_worker(agent, command_rx, event_tx, model.clone(), mcp);

    let mut app = App::new(model, session_id);
    app.cwd = cwd;
    app.mcp_servers = mcp_servers;
    let mut terminal_events = crossterm::event::EventStream::new();
    // Cron scheduler tick: check for due fires every 30 seconds.
    let mut cron_tick = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        terminal.draw(|frame| render::render(frame, &app))?;
        if app.should_quit {
            break;
        }

        tokio::select! {
            maybe_event = terminal_events.next() => match maybe_event {
                Some(Ok(event)) => handle_terminal_event(event, &mut app, &command_tx, &cancel),
                Some(Err(_)) => {}
                None => break,
            },
            maybe_agent_event = event_rx.recv() => match maybe_agent_event {
                Some(event) => app.apply_agent_event(event),
                None => break,
            },
            _ = cron_tick.tick() => {
                let _ = command_tx.send(AgentCommand::CronTick);
            },
        }
    }
    Ok(())
}

fn handle_terminal_event(
    event: Event,
    app: &mut App,
    commands: &mpsc::UnboundedSender<AgentCommand>,
    cancel: &Arc<Notify>,
) {
    let Event::Key(KeyEvent {
        code,
        modifiers,
        kind,
        ..
    }) = event
    else {
        return;
    };
    if kind != KeyEventKind::Press {
        return;
    }

    // The approval prompt swallows every key until answered.
    if let Some(approval) = app.pending_approval.take() {
        match code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                let _ = approval.respond.send(true);
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                let _ = approval.respond.send(false);
            }
            _ => {
                app.pending_approval = Some(approval);
            }
        }
        return;
    }

    // Ctrl+C always interrupts or quits, even with a popup open.
    if code == KeyCode::Char('c') && modifiers.contains(KeyModifiers::CONTROL) {
        app.picker = None;
        app.mcp_panel = false;
        app.mention = None;
        if app.status == Status::Generating {
            cancel.notify_waiters();
            cancel.notify_one();
        } else {
            app.should_quit = true;
        }
        return;
    }

    // The selector popup swallows navigation keys while open.
    if app.picker.is_some() {
        let outcome = {
            let picker = app.picker.as_mut().expect("picker checked above");
            match code {
                KeyCode::Up => {
                    picker.move_up();
                    PickerOutcome::None
                }
                KeyCode::Down => {
                    picker.move_down();
                    PickerOutcome::None
                }
                KeyCode::Esc => PickerOutcome::Close,
                KeyCode::Enter => picker
                    .selected_item()
                    .cloned()
                    .map(|item| PickerOutcome::Choose(picker.kind, item))
                    .unwrap_or(PickerOutcome::None),
                _ => PickerOutcome::None,
            }
        };
        match outcome {
            PickerOutcome::None => {}
            PickerOutcome::Close => app.picker = None,
            PickerOutcome::Choose(kind, item) => {
                app.picker = None;
                let command = match kind {
                    PickerKind::Model => AgentCommand::SwitchModel(item.id.clone()),
                    PickerKind::Sessions => AgentCommand::SwitchSession(item.id.clone()),
                };
                let _ = commands.send(command);
                app.push_notice(&format!("switching to {}…", item.label));
            }
        }
        return;
    }

    // The `/mcp` panel: navigate, Enter toggles/installs, d uninstalls.
    if app.mcp_panel {
        match code {
            KeyCode::Up => {
                app.mcp_confirm = None;
                app.move_mcp_selection(-1);
            }
            KeyCode::Down => {
                app.mcp_confirm = None;
                app.move_mcp_selection(1);
            }
            KeyCode::Enter => {
                app.mcp_confirm = None;
                match app.selected_mcp_row() {
                    Some(McpRow::Server(index)) => {
                        if let Some(server) = app.mcp_servers.get(index) {
                            let _ = commands.send(AgentCommand::McpToggle(server.name.clone()));
                        }
                    }
                    Some(McpRow::Recommended(index)) => {
                        if let Some(recommendation) = MCP_RECOMMENDATIONS.get(index) {
                            let _ = commands
                                .send(AgentCommand::McpInstall(recommendation.name.to_string()));
                        }
                    }
                    None => {}
                }
            }
            KeyCode::Char('d') => match app.selected_mcp_row() {
                Some(McpRow::Server(index)) => {
                    if let Some(server) = app.mcp_servers.get(index) {
                        if app.mcp_confirm.as_deref() == Some(server.name.as_str()) {
                            let _ = commands.send(AgentCommand::McpUninstall(server.name.clone()));
                            app.mcp_confirm = None;
                        } else {
                            app.mcp_confirm = Some(server.name.clone());
                        }
                    }
                }
                _ => app.mcp_confirm = None,
            },
            KeyCode::Esc => {
                app.mcp_confirm = None;
                app.mcp_panel = false;
            }
            _ => {}
        }
        return;
    }

    // The mention popup swallows completion keys while open.
    if app.mention.is_some() {
        match code {
            KeyCode::Up => app.move_mention(-1),
            KeyCode::Down => app.move_mention(1),
            KeyCode::Tab | KeyCode::Enter => {
                app.accept_mention();
            }
            KeyCode::Esc => app.mention = None,
            _ => {}
        }
        if matches!(
            code,
            KeyCode::Up | KeyCode::Down | KeyCode::Tab | KeyCode::Enter | KeyCode::Esc
        ) {
            return;
        }
    }

    let generating = app.status == Status::Generating;

    match code {
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            if generating {
                cancel.notify_waiters();
                cancel.notify_one();
            } else {
                app.should_quit = true;
            }
        }
        KeyCode::Esc => {
            if generating {
                cancel.notify_waiters();
                cancel.notify_one();
            } else {
                app.input.clear();
                app.mention = None;
            }
        }
        KeyCode::Enter => {
            if !generating {
                app.mention = None;
                let input = app.input.take();
                let trimmed = input.trim().to_string();
                if trimmed.is_empty() {
                    return;
                }
                if let Some(command) = SlashCommand::parse(&trimmed) {
                    match command {
                        SlashCommand::Help => app.push_notice(commands::HELP_TEXT),
                        SlashCommand::Clear => {
                            app.transcript.clear();
                            let _ = commands.send(AgentCommand::Clear);
                        }
                        SlashCommand::Exit => app.should_quit = true,
                        SlashCommand::Model => open_model_picker(app),
                        SlashCommand::Sessions => open_sessions_picker(app),
                        SlashCommand::Usage => {
                            let _ = commands.send(AgentCommand::Usage);
                        }
                        SlashCommand::Mcp => {
                            if app.mcp_servers.is_empty() {
                                app.push_notice("no MCP servers connected");
                            } else {
                                app.mcp_panel = true;
                            }
                        }
                    }
                } else if trimmed.starts_with('/') {
                    app.push_notice(&format!("unknown command: {trimmed}"));
                } else {
                    app.push_user_message(trimmed.clone());
                    app.status = Status::Generating;
                    let _ = commands.send(AgentCommand::Turn(trimmed));
                }
            }
        }
        KeyCode::Char(character) => {
            if !generating && !modifiers.contains(KeyModifiers::CONTROL) {
                app.input.insert(character);
            }
        }
        KeyCode::Backspace => {
            if !generating {
                app.input.backspace();
            }
        }
        KeyCode::Delete => {
            if !generating {
                app.input.delete();
            }
        }
        KeyCode::Left => {
            if !generating {
                app.input.move_left();
            }
        }
        KeyCode::Right => {
            if !generating {
                app.input.move_right();
            }
        }
        KeyCode::Home => {
            if generating {
                app.scroll = u16::MAX;
            } else {
                app.input.move_home();
            }
        }
        KeyCode::End => {
            if generating {
                app.scroll = 0;
            } else {
                app.input.move_end();
            }
        }
        KeyCode::Up => {
            if generating {
                app.scroll = app.scroll.saturating_add(1);
            } else {
                app.input.history_prev();
            }
        }
        KeyCode::Down => {
            if generating {
                app.scroll = app.scroll.saturating_sub(1);
            } else {
                app.input.history_next();
            }
        }
        KeyCode::PageUp => {
            app.scroll = app.scroll.saturating_add(10);
        }
        KeyCode::PageDown => {
            app.scroll = app.scroll.saturating_sub(10);
        }
        _ => {}
    }
    app.refresh_mentions();
}

/// Result of handling a key while the picker is open.
enum PickerOutcome {
    None,
    Close,
    Choose(PickerKind, PickerItem),
}

/// Open the model picker listing aliases from config.toml.
fn open_model_picker(app: &mut App) {
    let config = match lmcode_core::config::load_config(None) {
        Ok(config) => config,
        Err(error) => {
            app.push_notice(&format!("failed to load config: {error}"));
            return;
        }
    };
    let mut items: Vec<PickerItem> = config
        .models
        .iter()
        .map(|(alias, model)| PickerItem {
            id: alias.clone(),
            label: model
                .display_name
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| alias.clone()),
            detail: alias.clone(),
        })
        .collect();
    items.sort_by(|a, b| a.label.cmp(&b.label));
    if items.is_empty() {
        app.push_notice("no models configured in config.toml");
        return;
    }
    app.picker = Some(Picker::new(PickerKind::Model, "select model", items));
}

/// Open the session picker for the current directory.
fn open_sessions_picker(app: &mut App) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let store = lmcode_core::session::SessionStore::new();
    let sessions = match store.list(&cwd) {
        Ok(sessions) => sessions,
        Err(error) => {
            app.push_notice(&format!("failed to list sessions: {error}"));
            return;
        }
    };
    let items: Vec<PickerItem> = sessions
        .iter()
        .map(|state| PickerItem {
            id: state.id.clone(),
            label: state
                .title
                .clone()
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| state.id.clone()),
            detail: format!("{} · {}", state.updated_at, short_id(&state.id)),
        })
        .collect();
    if items.is_empty() {
        app.push_notice("no sessions for this directory");
        return;
    }
    app.picker = Some(Picker::new(PickerKind::Sessions, "select session", items));
}

fn short_id(id: &str) -> String {
    id.chars()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}
