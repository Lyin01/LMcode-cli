//! LMcode desktop app — Tauri front end over the shared agent core.
//!
//! The window talks to the agent through two IPC commands (`send_message`,
//! `approve_tool`) plus the read-only panel queries; the agent worker lives
//! in `bridge` and streams back `agent-event`s. Everything the agent does is
//! forwarded to the frontend as `agent-event` payloads.
//!
//! Always compiled as a GUI subsystem binary: no console window appears on
//! any build (debug included), from any launch path.
#![windows_subsystem = "windows"]

mod bridge;
mod remote;

use std::sync::Arc;

use bridge::{AgentCommand, start_agent};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, mpsc, oneshot};

/// Shared state exposed to IPC commands.
pub struct AppState {
    commands: mpsc::UnboundedSender<AgentCommand>,
    approval: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    status: Arc<Mutex<Option<bridge::StatusPayload>>>,
    terminal: Arc<tokio::sync::Mutex<Option<bridge::TerminalSession>>>,
    subagents: lmcode_core::subagent::SubagentLog,
    inbox: bridge::InboxLog,
    /// Broadcast sender for the LAN remote service.
    events_tx: tokio::sync::broadcast::Sender<String>,
    remote: Arc<tokio::sync::Mutex<Option<remote::RemoteService>>>,
    cancel: Arc<tokio::sync::Notify>,
}

/// Frontend-readable status (model + session); avoids the load race where the
/// `SessionReady` event fires before the webview subscribes.
#[tauri::command]
async fn get_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<bridge::StatusPayload>, String> {
    Ok(state.status.lock().await.clone())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    message: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    if message.trim().is_empty() && images.as_deref().unwrap_or(&[]).is_empty() {
        return Ok(());
    }
    state
        .commands
        .send(AgentCommand::Turn {
            text: message,
            images: images.unwrap_or_default(),
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn approve_tool(state: tauri::State<'_, AppState>, approved: bool) -> Result<(), String> {
    let mut slot = state.approval.lock().await;
    if let Some(respond) = slot.take() {
        let _ = respond.send(approved);
    }
    Ok(())
}

#[tauri::command]
async fn cancel_turn(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.cancel.notify_waiters();
    state.cancel.notify_one();
    Ok(())
}

/// List persisted sessions for the current working directory.
#[tauri::command]
async fn list_sessions() -> Result<Vec<bridge::SessionSummary>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let store = lmcode_core::session::SessionStore::new();
    let sessions = store.list(&cwd).map_err(|error| error.to_string())?;
    Ok(sessions
        .iter()
        .map(bridge::SessionSummary::from_state)
        .collect())
}

/// Resume a session: returns its flattened history and tells the worker to
/// attach it.
#[tauri::command]
async fn resume_session(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<bridge::HistoryMessage>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let store = lmcode_core::session::SessionStore::new();
    let session = store.load(&cwd, &id).map_err(|error| error.to_string())?;
    let history = bridge::history_view(&session.messages);
    state
        .commands
        .send(AgentCommand::Resume(id))
        .map_err(|error| error.to_string())?;
    Ok(history)
}

#[tauri::command]
async fn new_session(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .commands
        .send(AgentCommand::NewSession)
        .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelOption {
    alias: String,
    display_name: String,
}

#[derive(serde::Serialize)]
struct SettingsPayload {
    model: String,
    session: String,
    cwd: String,
    models: Vec<ModelOption>,
}

#[tauri::command]
async fn get_settings(state: tauri::State<'_, AppState>) -> Result<SettingsPayload, String> {
    let status = state.status.lock().await.clone();
    let cwd = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let models = lmcode_core::config::load_config(None)
        .map(|config| {
            let mut models: Vec<ModelOption> = config
                .models
                .iter()
                .map(|(alias, model)| ModelOption {
                    alias: alias.clone(),
                    display_name: model.display_name.clone().unwrap_or_else(|| alias.clone()),
                })
                .collect();
            models.sort_by(|a, b| a.alias.cmp(&b.alias));
            models
        })
        .unwrap_or_default();
    Ok(SettingsPayload {
        model: status.as_ref().map(|s| s.model.clone()).unwrap_or_default(),
        session: status
            .as_ref()
            .map(|s| s.session.clone())
            .unwrap_or_default(),
        cwd,
        models,
    })
}

#[tauri::command]
async fn set_model(state: tauri::State<'_, AppState>, alias: String) -> Result<(), String> {
    state
        .commands
        .send(AgentCommand::SwitchModel(alias))
        .map_err(|error| error.to_string())
}

/// One memo row for the desktop memory browser.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoSummary {
    id: String,
    kind: String,
    user_need: String,
    outcome: String,
    project_dir: String,
    tags: Vec<String>,
    recorded_at: i64,
}

#[tauri::command]
async fn list_memos() -> Result<Vec<MemoSummary>, String> {
    let store = lmcode_memory::MemoStore::open(&lmcode_memory::MemoStore::default_path())
        .map_err(|error| error.to_string())?;
    let mut memos = store.all().map_err(|error| error.to_string())?;
    // Newest first.
    memos.sort_by_key(|memo| std::cmp::Reverse(memo.recorded_at));
    Ok(memos
        .into_iter()
        .map(|memo| MemoSummary {
            id: memo.id,
            kind: memo.kind.as_str().to_string(),
            user_need: memo.user_need,
            outcome: memo.outcome,
            project_dir: memo.project_dir,
            tags: memo.tags,
            recorded_at: memo.recorded_at,
        })
        .collect())
}

#[tauri::command]
async fn delete_memo(id: String) -> Result<bool, String> {
    let store = lmcode_memory::MemoStore::open(&lmcode_memory::MemoStore::default_path())
        .map_err(|error| error.to_string())?;
    store.delete(&id).map_err(|error| error.to_string())
}

/// Working-tree changes for the Git review panel.
#[tauri::command]
async fn git_status() -> Result<Vec<bridge::GitChange>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let output = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(bridge::parse_git_status(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Unified diff for one path (staged or worktree).
#[tauri::command]
async fn git_diff(path: String, staged: bool) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut args: Vec<String> = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(path);
    let output = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Start the persistent shell session backing the terminal panel.
#[tauri::command]
async fn terminal_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut slot = state.terminal.lock().await;
    if slot.is_some() {
        return Err("terminal is already running".to_string());
    }
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("cmd");
        // Quiet echo, UTF-8 code page, then clear the (OEM-encoded) banner.
        command.args(["/Q", "/K", "chcp 65001>nul & cls"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new("sh");
    command
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start shell: {error}"))?;
    let stdin = child.stdin.take().ok_or("shell has no stdin")?;
    let stdout = child.stdout.take().ok_or("shell has no stdout")?;
    let stderr = child.stderr.take().ok_or("shell has no stderr")?;
    spawn_terminal_readers(app, stdout, stderr);
    *slot = Some(bridge::TerminalSession { stdin, child });
    Ok(())
}

/// Spawn output readers that forward chunks to the webview.
fn spawn_terminal_readers(
    app: tauri::AppHandle,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) {
    use tokio::io::AsyncReadExt;
    for mut stream in [
        Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        Box::new(stderr),
    ] {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut buffer = [0u8; 4096];
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                        let _ = handle.emit("terminal-output", chunk);
                    }
                }
            }
        });
    }
}

/// Write one command line to the shell session.
#[tauri::command]
async fn terminal_write(state: tauri::State<'_, AppState>, command: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut slot = state.terminal.lock().await;
    let session = slot.as_mut().ok_or("terminal is not running".to_string())?;
    session
        .stdin
        .write_all(format!("{command}\n").as_bytes())
        .await
        .map_err(|error| format!("failed to write to shell: {error}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush shell: {error}"))
}

/// Stop the shell session (kills the process).
#[tauri::command]
async fn terminal_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.terminal.lock().await;
    if let Some(mut session) = slot.take() {
        let _ = session.child.kill().await;
    }
    Ok(())
}

/// One cron task row for the automations panel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskRow {
    id: String,
    cron: String,
    prompt: String,
    recurring: bool,
    created_at: u64,
    last_fired_at: Option<u64>,
}

fn cron_store() -> lmcode_core::cron::CronStore {
    lmcode_core::cron::CronStore::with_dir(lmcode_core::config::lmcode_home().join("cron"))
}

#[tauri::command]
async fn list_cron_tasks() -> Result<Vec<CronTaskRow>, String> {
    let store = cron_store();
    Ok(store
        .list()
        .iter()
        .map(|task| CronTaskRow {
            id: task.id.clone(),
            cron: task.cron.clone(),
            prompt: task.prompt.clone(),
            recurring: task.is_recurring(),
            created_at: task.created_at,
            last_fired_at: task.last_fired_at,
        })
        .collect())
}

#[tauri::command]
async fn create_cron_task(cron: String, prompt: String, recurring: bool) -> Result<String, String> {
    let mut store = cron_store();
    let task = store.add(&cron, &prompt, recurring)?;
    Ok(task.id)
}

#[tauri::command]
async fn delete_cron_task(id: String) -> Result<bool, String> {
    let mut store = cron_store();
    Ok(store.remove(&id))
}

/// List git worktrees for the worktrees panel.
#[tauri::command]
async fn worktree_list() -> Result<Vec<bridge::WorktreeInfo>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let output = tokio::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(bridge::parse_worktree_list(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Create a worktree (optionally on a new branch).
#[tauri::command]
async fn worktree_add(path: String, branch: Option<String>) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut args: Vec<String> = vec!["worktree".to_string(), "add".to_string()];
    if let Some(branch) = branch.as_deref().filter(|branch| !branch.trim().is_empty()) {
        args.push("-b".to_string());
        args.push(branch.to_string());
    }
    args.push(path);
    let output = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Remove a worktree by path.
#[tauri::command]
async fn worktree_remove(path: String) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let output = tokio::process::Command::new("git")
        .args(["worktree", "remove", &path])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Recent subagent runs for the subagent panel.
#[tauri::command]
async fn list_subagents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<lmcode_core::subagent::SubagentRun>, String> {
    Ok(state
        .subagents
        .lock()
        .map_err(|_| "subagent log lock poisoned".to_string())?
        .clone())
}

/// Inbox entries (desktop notification history).
#[tauri::command]
async fn list_inbox(state: tauri::State<'_, AppState>) -> Result<Vec<bridge::InboxItem>, String> {
    Ok(state
        .inbox
        .lock()
        .map_err(|_| "inbox lock poisoned".to_string())?
        .clone())
}

/// Mark every inbox entry as read.
#[tauri::command]
async fn mark_inbox_read(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inbox = state
        .inbox
        .lock()
        .map_err(|_| "inbox lock poisoned".to_string())?;
    for item in inbox.iter_mut() {
        item.read = true;
    }
    Ok(())
}

/// Clear the inbox.
#[tauri::command]
async fn clear_inbox(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inbox = state
        .inbox
        .lock()
        .map_err(|_| "inbox lock poisoned".to_string())?;
    inbox.clear();
    Ok(())
}

/// One artifact row for the artifact panel (plan documents).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactRow {
    id: String,
    name: String,
    modified_at: u64,
}

#[tauri::command]
async fn list_artifacts() -> Result<Vec<ArtifactRow>, String> {
    let dir = lmcode_core::config::lmcode_home().join("plans");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut rows: Vec<ArtifactRow> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
        let modified_at = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        rows.push(ArtifactRow {
            id: id.clone(),
            name: format!("{id}.md"),
            modified_at,
        });
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.modified_at));
    Ok(rows)
}

#[tauri::command]
async fn read_artifact(id: String) -> Result<String, String> {
    // The id must be a bare file stem: reject separators and traversal.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid artifact id".to_string());
    }
    let path = lmcode_core::config::lmcode_home()
        .join("plans")
        .join(format!("{id}.md"));
    std::fs::read_to_string(&path).map_err(|error| format!("failed to read artifact: {error}"))
}

/// Current remote service state (None when stopped).
#[tauri::command]
async fn remote_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<remote::RemoteState>, String> {
    Ok(state
        .remote
        .lock()
        .await
        .as_ref()
        .map(|service| service.state.clone()))
}

/// Start the LAN remote service (idempotent).
#[tauri::command]
async fn remote_start(state: tauri::State<'_, AppState>) -> Result<remote::RemoteState, String> {
    let mut slot = state.remote.lock().await;
    if let Some(service) = slot.as_ref() {
        return Ok(service.state.clone());
    }
    let service = remote::RemoteService::start(
        state.commands.clone(),
        Arc::clone(&state.approval),
        state.events_tx.clone(),
        Arc::clone(&state.status),
    )
    .await?;
    let remote_state = service.state.clone();
    *slot = Some(service);
    Ok(remote_state)
}

/// Stop the LAN remote service.
#[tauri::command]
async fn remote_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.remote.lock().await;
    if let Some(mut service) = slot.take() {
        service.stop();
    }
    Ok(())
}

/// Optional `--message <text>` / `--message=<text>` startup prompt (mirrors
/// the CLI's `-p`); useful for automation and smoke tests.
fn initial_message() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--message=") {
            return Some(value.to_string());
        }
        if arg == "--message" {
            return args.get(index + 1).cloned();
        }
    }
    None
}

fn main() {
    // TEMP DEBUG: surface panics in GUI processes.
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[panic] {info}");
    }));
    let initial = initial_message();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            send_message,
            approve_tool,
            cancel_turn,
            get_status,
            list_sessions,
            resume_session,
            new_session,
            get_settings,
            set_model,
            list_memos,
            delete_memo,
            git_status,
            git_diff,
            terminal_start,
            terminal_write,
            terminal_stop,
            list_cron_tasks,
            create_cron_task,
            delete_cron_task,
            worktree_list,
            worktree_add,
            worktree_remove,
            list_subagents,
            list_inbox,
            mark_inbox_read,
            clear_inbox,
            list_artifacts,
            read_artifact,
            remote_status,
            remote_start,
            remote_stop
        ])
        .setup(|app| {
            let (commands_tx, commands_rx) = mpsc::unbounded_channel();
            let approval = Arc::new(Mutex::new(None));
            let status = Arc::new(Mutex::new(None));
            let subagents: lmcode_core::subagent::SubagentLog =
                Arc::new(std::sync::Mutex::new(Vec::new()));
            let inbox: bridge::InboxLog = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (events_tx, _) = tokio::sync::broadcast::channel::<String>(256);
            let cancel = Arc::new(tokio::sync::Notify::new());
            app.manage(AppState {
                commands: commands_tx,
                approval: Arc::clone(&approval),
                status: Arc::clone(&status),
                terminal: Arc::new(tokio::sync::Mutex::new(None)),
                subagents: Arc::clone(&subagents),
                inbox: Arc::clone(&inbox),
                events_tx: events_tx.clone(),
                remote: Arc::new(tokio::sync::Mutex::new(None)),
                cancel: Arc::clone(&cancel),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_agent(
                    handle,
                    commands_rx,
                    bridge::StartupContext {
                        approval,
                        status,
                        subagents,
                        inbox,
                        events_tx,
                        cancel,
                    },
                    initial,
                )
                .await
                {
                    eprintln!("failed to start agent: {error}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
