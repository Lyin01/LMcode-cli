//! stdio JSON-Lines JSON-RPC for the desktop.
//!
//! One process speaks the Codex-shaped thread/turn protocol plus the LMcode
//! panel methods. `lm app-server` is the binary. The driver process and MCP
//! server processes are not spawned here: computer-use activation reports
//! that, and MCP methods read and write `mcp.json`.

mod script;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use async_trait::async_trait;
use lmcode_core::agent::{Agent, SteerSlot, TurnUi};
use lmcode_core::computer_use::{
    ComputerUseActivation, ComputerUseController, ComputerUseHost, ComputerUseLaunch,
    ComputerUsePhase, ComputerUseServerView, ComputerUseStatus, HostPlatform,
};
use lmcode_core::config::{
    ComputerUseConfig, ComputerUsePermissionMode, default_config_path, load_config, resolve_model,
    save_config,
};
use lmcode_core::cron::CronStore;
use lmcode_core::goal::{GoalMode, GoalStatus};
use lmcode_core::session::{Session, SessionStore};
use lmcode_core::tools::ask_user::{AskUserAnswer, UserQuestion};
use lmcode_core::tools::cron::CronHandle;
use lmcode_core::tools::goal::GoalHandle;
use lmcode_core::tools::{AskUserQuestionTool, BashTool, Tool};
use lmcode_llm::provider::ChatProvider;
use lmcode_llm::providers::create_provider;
use lmcode_memory::{MemoStore, rank_memos};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, Notify, mpsc, oneshot};

use script::ScriptProvider;

type Out = Arc<Mutex<tokio::io::Stdout>>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }

    fn params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn method(name: &str) -> Self {
        Self {
            code: -32601,
            message: format!("unknown method `{name}`"),
        }
    }
}

struct ActiveThread {
    id: String,
    cwd: PathBuf,
    model: String,
    agent: Arc<Mutex<Agent>>,
    steer: Arc<SteerSlot>,
    cancel: Arc<Notify>,
    goal: GoalHandle,
    cron: CronHandle,
    running: Arc<AtomicBool>,
}

struct JsonUi {
    out: Out,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    thread_id: String,
    turn_id: String,
    text: String,
}

impl JsonUi {
    async fn notify(&self, method: &str, params: Value) {
        let _ = send_value(
            &self.out,
            &json!({"jsonrpc": "2.0", "method": method, "params": params}),
        )
        .await;
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("server:{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id_key(&Value::String(id.clone())), tx);
        send_value(
            &self.out,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )
        .await?;
        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(value)) => {
                if let Some(error) = value.get("error") {
                    Err(error.to_string())
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => Err("client did not answer".to_string()),
        }
    }
}

#[async_trait]
impl TurnUi for JsonUi {
    async fn text_delta(&mut self, text: &str) {
        self.text.push_str(text);
        self.notify(
            "item/agentMessage/delta",
            json!({"threadId": self.thread_id, "turnId": self.turn_id, "delta": text}),
        )
        .await;
    }

    async fn think_delta(&mut self, text: &str) {
        self.notify(
            "item/reasoning/delta",
            json!({"threadId": self.thread_id, "turnId": self.turn_id, "delta": text}),
        )
        .await;
    }

    async fn tool_start(&mut self, name: &str, arguments: &str) {
        self.notify(
            "item/tool/started",
            json!({
                "threadId": self.thread_id,
                "turnId": self.turn_id,
                "tool": name,
                "arguments": arguments,
            }),
        )
        .await;
    }

    async fn tool_end(&mut self, name: &str, ok: bool, result: &str) {
        self.notify(
            "item/tool/completed",
            json!({
                "threadId": self.thread_id,
                "turnId": self.turn_id,
                "tool": name,
                "ok": ok,
                "result": result,
            }),
        )
        .await;
    }

    async fn approve(&mut self, name: &str, arguments: &str) -> bool {
        let params = json!({
            "threadId": self.thread_id,
            "turnId": self.turn_id,
            "tool": name,
            "arguments": arguments,
        });
        match self
            .request("item/commandExecution/requestApproval", params)
            .await
        {
            Ok(value) => value
                .get("approved")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    async fn ask_user(&mut self, questions: &[UserQuestion]) -> AskUserAnswer {
        let payload: Vec<Value> = questions
            .iter()
            .map(|question| {
                json!({
                    "question": question.question,
                    "header": question.header,
                    "multiSelect": question.multi_select,
                    "options": question.options.iter().map(|option| json!({
                        "label": option.label,
                        "description": option.description,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        match self
            .request(
                "item/tool/requestUserInput",
                json!({
                    "threadId": self.thread_id,
                    "turnId": self.turn_id,
                    "questions": payload,
                }),
            )
            .await
        {
            Ok(value) => {
                AskUserAnswer::Payload(value.get("answers").cloned().unwrap_or(Value::Null))
            }
            Err(error) => AskUserAnswer::Failed(error),
        }
    }

    async fn notice(&mut self, message: &str) {
        self.notify(
            "turn/notice",
            json!({"threadId": self.thread_id, "turnId": self.turn_id, "message": message}),
        )
        .await;
    }
}

#[derive(Default)]
struct UnspawnedHost;

#[async_trait]
impl ComputerUseHost for UnspawnedHost {
    fn get(&self, _name: &str) -> Option<ComputerUseServerView> {
        None
    }

    async fn add_server(&mut self, _name: &str, _launch: &ComputerUseLaunch) -> Result<(), String> {
        Err("driver process is not launched".to_string())
    }

    async fn reconnect(&mut self, _name: &str) -> Result<(), String> {
        Err("driver process is not launched".to_string())
    }

    async fn remove_server(&mut self, _name: &str) -> Result<(), String> {
        Ok(())
    }

    async fn stop_server(&mut self, _name: &str) -> Result<(), String> {
        Ok(())
    }
}

struct Server {
    out: Out,
    pending: Pending,
    next_server_id: Arc<AtomicU64>,
    active: Option<ActiveThread>,
    computer: ComputerUseController<UnspawnedHost>,
}

impl Server {
    fn new(out: Out, pending: Pending) -> Self {
        let platform = if cfg!(windows) {
            HostPlatform::Windows
        } else {
            HostPlatform::Unix
        };
        let computer = ComputerUseController::new(
            UnspawnedHost,
            platform,
            std::env::vars().collect(),
            |path| path.exists(),
        );
        Self {
            out,
            pending,
            next_server_id: Arc::new(AtomicU64::new(1)),
            active: None,
            computer,
        }
    }

    async fn handle(&mut self, message: Value) {
        let Some(method) = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let Some(id) = message.get("id").cloned() else {
            return;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match self.dispatch(&method, &params).await {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": error.code, "message": error.message},
            }),
        };
        if let Err(error) = send_value(&self.out, &response).await {
            eprintln!("app-server: {error}");
        }
    }

    async fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "serverInfo": {"name": "lmcode", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {
                    "thread": true,
                    "turn": true,
                    "approval": true,
                    "question": true,
                    "goal": true,
                    "cron": true,
                    "mcp": true,
                    "memory": true,
                    "config": true,
                    "computerUse": true,
                },
            })),
            "thread/start" => self.thread_start(params).await,
            "thread/resume" => self.thread_resume(params).await,
            "thread/list" => self.thread_list(params),
            "thread/fork" => self.thread_fork(params).await,
            "thread/delete" => self.thread_delete(params),
            "thread/rename" => self.thread_rename(params).await,
            "turn/start" => self.turn_start(params).await,
            "turn/steer" => self.turn_steer(params),
            "turn/interrupt" => self.turn_interrupt(),
            "config/read" => config_read(params),
            "config/write" => config_write(params),
            "goal/get" => self.goal_get().await,
            "goal/create" => self.goal_create(params).await,
            "goal/update" => self.goal_update(params).await,
            "goal/cancel" => self.goal_cancel().await,
            "cron/list" => self.cron_list().await,
            "cron/create" => self.cron_create(params).await,
            "cron/delete" => self.cron_delete(params).await,
            "mcp/list" => self.mcp_list(),
            "mcp/add" => self.mcp_add(params),
            "mcp/remove" => self.mcp_remove(params),
            "mcp/stop" => mcp_not_spawned(params),
            "mcp/reconnect" => mcp_not_spawned(params),
            "memory/list" => memory_list(),
            "memory/search" => memory_search(params),
            "memory/delete" => memory_delete(params),
            "computerUse/status" => Ok(status_json(self.computer.status())),
            "computerUse/setEnabled" => self.computer_set_enabled(params).await,
            other => Err(RpcError::method(other)),
        }
    }

    fn ensure_idle(&self) -> Result<(), RpcError> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.running.load(Ordering::SeqCst))
        {
            Err(RpcError::failed("a turn is already running"))
        } else {
            Ok(())
        }
    }

    async fn thread_start(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = require_str(params, "cwd")?;
        let model = params
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("script");
        let session = SessionStore::new()
            .create(Path::new(cwd), model)
            .map_err(failed)?;
        let active = open_thread(Path::new(cwd), model, session)?;
        let view = load_thread(&active.cwd, &active.id)?;
        self.active = Some(active);
        Ok(json!({"thread": view}))
    }

    async fn thread_resume(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let id = require_str(params, "threadId")?;
        let session = SessionStore::new().load(&cwd, id).map_err(failed)?;
        let model = session.state.model.clone();
        let active = open_thread(&cwd, &model, session)?;
        let view = load_thread(&cwd, id)?;
        self.active = Some(active);
        Ok(json!({"thread": view}))
    }

    fn thread_list(&self, params: &Value) -> Result<Value, RpcError> {
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let states = SessionStore::new().list(&cwd).map_err(failed)?;
        let threads = states
            .into_iter()
            .map(|state| {
                json!({
                    "id": state.id,
                    "cwd": state.work_dir,
                    "model": state.model,
                    "title": state.title,
                    "forkedFrom": state.forked_from,
                    "updatedAt": state.updated_at,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"threads": threads}))
    }

    async fn thread_fork(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let source = require_str(params, "threadId")?.to_string();
        let target = format!("session_{}", uuid::Uuid::new_v4());
        let forked = SessionStore::new()
            .fork(&cwd, &source, &target)
            .map_err(failed)?;
        let goal = GoalMode::with_path(forked.directory().join("goal.json")).snapshot();
        let tasks = CronStore::with_dir(forked.directory().join("cron"))
            .list()
            .to_vec();
        Ok(json!({
            "thread": session_value(&forked)?,
            "goal": goal_value(goal)?,
            "tasks": serde_json::to_value(tasks).map_err(failed)?,
        }))
    }

    fn thread_delete(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let id = require_str(params, "threadId")?;
        SessionStore::new().delete(&cwd, id).map_err(failed)?;
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            self.active = None;
        }
        Ok(json!({"deleted": true}))
    }

    async fn thread_rename(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let id = require_str(params, "threadId")?.to_string();
        let title = require_str(params, "title")?;
        SessionStore::new()
            .rename(&cwd, &id, title)
            .map_err(failed)?;
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            let model = self.active.as_ref().expect("active").model.clone();
            let session = SessionStore::new().load(&cwd, &id).map_err(failed)?;
            self.active = Some(open_thread(&cwd, &model, session)?);
        }
        let session = SessionStore::new().load(&cwd, &id).map_err(failed)?;
        Ok(json!({"thread": session_value(&session)?}))
    }

    async fn turn_start(&mut self, params: &Value) -> Result<Value, RpcError> {
        let text = require_str(params, "text")?.to_string();
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?;
        if let Some(id) = params.get("threadId").and_then(Value::as_str)
            && id != active.id
        {
            return Err(RpcError::failed("thread is not the active thread"));
        }
        if active.running.swap(true, Ordering::SeqCst) {
            return Err(RpcError::failed("a turn is already running"));
        }
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4());
        let thread_id = active.id.clone();
        let agent = Arc::clone(&active.agent);
        let running = Arc::clone(&active.running);
        let out = Arc::clone(&self.out);
        let pending = Arc::clone(&self.pending);
        let next_id = Arc::clone(&self.next_server_id);
        let turn_for_task = turn_id.clone();
        let thread_for_task = thread_id.clone();
        tokio::spawn(async move {
            let mut ui = JsonUi {
                out: Arc::clone(&out),
                pending,
                next_id,
                thread_id: thread_for_task.clone(),
                turn_id: turn_for_task.clone(),
                text: String::new(),
            };
            ui.notify(
                "turn/started",
                json!({
                    "threadId": thread_for_task.clone(),
                    "turnId": turn_for_task.clone(),
                }),
            )
            .await;
            let outcome = {
                let mut agent = agent.lock().await;
                agent.run_turn(&text, &mut ui).await
            };
            running.store(false, Ordering::SeqCst);
            let params = match outcome {
                Ok(outcome) => json!({
                    "threadId": thread_for_task,
                    "turnId": turn_for_task,
                    "status": if outcome.interrupted { "interrupted" } else { "completed" },
                    "steps": outcome.steps,
                    "text": ui.text,
                }),
                Err(error) => json!({
                    "threadId": thread_for_task,
                    "turnId": turn_for_task,
                    "status": "failed",
                    "text": ui.text,
                    "error": error.to_string(),
                }),
            };
            ui.notify("turn/completed", params).await;
        });
        Ok(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "status": "started",
        }))
    }

    fn turn_steer(&self, params: &Value) -> Result<Value, RpcError> {
        let text = require_str(params, "text")?;
        let accepted = self
            .active
            .as_ref()
            .is_some_and(|active| active.steer.submit(text));
        Ok(json!({"accepted": accepted}))
    }

    fn turn_interrupt(&self) -> Result<Value, RpcError> {
        let interrupted = self.active.as_ref().is_some_and(|active| {
            if !active.running.load(Ordering::SeqCst) {
                return false;
            }
            active.cancel.notify_one();
            true
        });
        Ok(json!({"interrupted": interrupted}))
    }

    async fn goal_get(&self) -> Result<Value, RpcError> {
        let goal = self.goal_handle()?;
        let snapshot = goal.lock().await.snapshot();
        Ok(json!({"goal": goal_value(snapshot)?}))
    }

    async fn goal_create(&self, params: &Value) -> Result<Value, RpcError> {
        let goal = self.goal_handle()?;
        let objective = require_str(params, "objective")?;
        let criterion = params.get("completionCriterion").and_then(Value::as_str);
        let replace = params
            .get("replace")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let snapshot = goal
            .lock()
            .await
            .create(objective, criterion, replace)
            .map_err(RpcError::failed)?;
        Ok(json!({"goal": serde_json::to_value(snapshot).map_err(failed)?}))
    }

    async fn goal_update(&self, params: &Value) -> Result<Value, RpcError> {
        let goal = self.goal_handle()?;
        let name = require_str(params, "status")?;
        let status = GoalStatus::from_name(name)
            .ok_or_else(|| RpcError::params(format!("unknown goal status `{name}`")))?;
        let reason = params.get("terminalReason").and_then(Value::as_str);
        let snapshot = goal
            .lock()
            .await
            .update_status(status, reason)
            .map_err(RpcError::failed)?;
        Ok(json!({"goal": serde_json::to_value(snapshot).map_err(failed)?}))
    }

    async fn goal_cancel(&self) -> Result<Value, RpcError> {
        let goal = self.goal_handle()?;
        let snapshot = goal
            .lock()
            .await
            .update_status(GoalStatus::Complete, Some("cancelled"))
            .map_err(RpcError::failed)?;
        Ok(json!({"goal": serde_json::to_value(snapshot).map_err(failed)?}))
    }

    async fn cron_list(&self) -> Result<Value, RpcError> {
        let cron = self.cron_handle()?;
        let tasks = cron.lock().await.list().to_vec();
        Ok(json!({"tasks": serde_json::to_value(tasks).map_err(failed)?}))
    }

    async fn cron_create(&self, params: &Value) -> Result<Value, RpcError> {
        let cron = self.cron_handle()?;
        let expression = require_str(params, "cron")?;
        let prompt = require_str(params, "prompt")?;
        let recurring = params
            .get("recurring")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let task = cron
            .lock()
            .await
            .add(expression, prompt, recurring)
            .map_err(RpcError::failed)?;
        Ok(json!({"task": serde_json::to_value(task).map_err(failed)?}))
    }

    async fn cron_delete(&self, params: &Value) -> Result<Value, RpcError> {
        let cron = self.cron_handle()?;
        let id = require_str(params, "id")?;
        let deleted = cron.lock().await.remove(id);
        Ok(json!({"deleted": deleted}))
    }

    fn mcp_list(&self) -> Result<Value, RpcError> {
        let sources =
            lmcode_mcp::config::load_effective_sources(&self.work_dir()).map_err(failed)?;
        let mut names = sources.keys().cloned().collect::<Vec<_>>();
        names.sort();
        let servers = names
            .into_iter()
            .map(|name| {
                let source = &sources[&name];
                json!({
                    "name": name,
                    "command": source.config.command,
                    "url": source.config.url,
                    "disabled": source.config.disabled.unwrap_or(false),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"servers": servers}))
    }

    fn mcp_add(&self, params: &Value) -> Result<Value, RpcError> {
        let name = require_str(params, "name")?;
        let config = params
            .get("config")
            .cloned()
            .ok_or_else(|| RpcError::params("missing `config`"))?;
        let path = lmcode_mcp::config::upsert_user_server(
            &lmcode_mcp::config::lmcode_home(),
            name,
            &config,
        )
        .map_err(failed)?;
        Ok(json!({"name": name, "path": path.display().to_string()}))
    }

    fn mcp_remove(&self, params: &Value) -> Result<Value, RpcError> {
        let name = require_str(params, "name")?;
        let removed = lmcode_mcp::config::remove_server(&self.work_dir(), name)
            .map_err(failed)?
            .is_some();
        Ok(json!({"removed": removed}))
    }

    async fn computer_set_enabled(&mut self, params: &Value) -> Result<Value, RpcError> {
        let enabled = params
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| RpcError::params("missing `enabled`"))?;
        let status = if enabled {
            self.computer
                .activate(ComputerUseActivation::default())
                .await
        } else {
            self.computer.deactivate().await;
            self.computer.status()
        };
        if let Some(active) = &self.active {
            active
                .agent
                .lock()
                .await
                .set_computer_use_active(status.phase == ComputerUsePhase::Active);
        }
        persist_computer_use(enabled)?;
        Ok(status_json(status))
    }

    fn goal_handle(&self) -> Result<GoalHandle, RpcError> {
        self.active
            .as_ref()
            .map(|active| Arc::clone(&active.goal))
            .ok_or_else(|| RpcError::failed("no active thread"))
    }

    fn cron_handle(&self) -> Result<CronHandle, RpcError> {
        self.active
            .as_ref()
            .map(|active| Arc::clone(&active.cron))
            .ok_or_else(|| RpcError::failed("no active thread"))
    }

    fn work_dir(&self) -> PathBuf {
        self.active
            .as_ref()
            .map(|active| active.cwd.clone())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

fn open_thread(cwd: &Path, model: &str, session: Session) -> Result<ActiveThread, RpcError> {
    let provider = build_provider(model)?;
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(BashTool::new()),
        Arc::new(AskUserQuestionTool::new()),
    ];
    let mut agent = Agent::new(provider, tools, "You are LMcode.", cwd.to_path_buf());
    if let Ok(config) = load_config(None) {
        agent.apply_permission_config(&config);
    }
    let directory = session.directory().to_path_buf();
    let cron_dir = directory.join("cron");
    std::fs::create_dir_all(&cron_dir).map_err(failed)?;
    let goal = Arc::new(Mutex::new(GoalMode::with_path(directory.join("goal.json"))));
    let cron = Arc::new(Mutex::new(CronStore::with_dir(cron_dir)));
    agent.attach_goal(Arc::clone(&goal));
    agent.attach_cron(Arc::clone(&cron));
    let cancel = Arc::new(Notify::new());
    agent.set_cancel_signal(Arc::clone(&cancel));
    if let Ok(store) = MemoStore::open(&MemoStore::default_path()) {
        agent.attach_memo_store(Arc::new(store));
    }
    let id = session.id().to_string();
    agent.attach_session(session);
    let steer = agent.steer_slot();
    Ok(ActiveThread {
        id,
        cwd: cwd.to_path_buf(),
        model: model.to_string(),
        agent: Arc::new(Mutex::new(agent)),
        steer,
        cancel,
        goal,
        cron,
        running: Arc::new(AtomicBool::new(false)),
    })
}

fn build_provider(model: &str) -> Result<Arc<dyn ChatProvider>, RpcError> {
    if model == "script" || model.starts_with("script-") {
        return Ok(Arc::new(ScriptProvider::new(model)));
    }
    let config = load_config(None).map_err(failed)?;
    let resolved = resolve_model(&config, Some(model)).map_err(failed)?;
    create_provider(resolved.into_provider_config()).map_err(failed)
}

fn load_thread(cwd: &Path, id: &str) -> Result<Value, RpcError> {
    let session = SessionStore::new().load(cwd, id).map_err(failed)?;
    session_value(&session)
}

fn session_value(session: &Session) -> Result<Value, RpcError> {
    Ok(json!({
        "id": session.state.id,
        "cwd": session.state.work_dir,
        "model": session.state.model,
        "title": session.state.title,
        "forkedFrom": session.state.forked_from,
        "createdAt": session.state.created_at,
        "updatedAt": session.state.updated_at,
        "messages": serde_json::to_value(&session.messages).map_err(failed)?,
    }))
}

fn goal_value(goal: Option<lmcode_core::goal::GoalSnapshot>) -> Result<Value, RpcError> {
    match goal {
        Some(goal) => serde_json::to_value(goal).map_err(failed),
        None => Ok(Value::Null),
    }
}

fn config_read(params: &Value) -> Result<Value, RpcError> {
    let path = config_path(params);
    let text = std::fs::read_to_string(&path).map_err(failed)?;
    Ok(json!({"path": path.display().to_string(), "text": text}))
}

fn config_write(params: &Value) -> Result<Value, RpcError> {
    let text = require_str(params, "text")?;
    let path = config_path(params);
    let temp = path.with_extension("toml.checking");
    std::fs::write(&temp, text).map_err(failed)?;
    if let Err(error) = load_config(Some(&temp)) {
        let _ = std::fs::remove_file(&temp);
        return Err(failed(error));
    }
    std::fs::write(&path, text).map_err(failed)?;
    let _ = std::fs::remove_file(&temp);
    Ok(json!({"path": path.display().to_string()}))
}

fn config_path(params: &Value) -> PathBuf {
    params
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path)
}

fn persist_computer_use(enabled: bool) -> Result<(), RpcError> {
    let path = default_config_path();
    let mut config = load_config(Some(&path)).map_err(failed)?;
    let mut section = config.computer_use.take().unwrap_or(ComputerUseConfig {
        enabled: false,
        provider: None,
        command: None,
        args: Vec::new(),
        permission_mode: None,
    });
    section.enabled = enabled;
    config.computer_use = Some(section);
    save_config(&path, &config).map_err(failed)
}

fn memory_list() -> Result<Value, RpcError> {
    let store = MemoStore::open(&MemoStore::default_path()).map_err(failed)?;
    let memos = store.all().map_err(failed)?;
    Ok(json!({"memories": serde_json::to_value(memos).map_err(failed)?}))
}

fn memory_search(params: &Value) -> Result<Value, RpcError> {
    let query = require_str(params, "query")?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .min(20) as usize;
    let min_score = params
        .get("minScore")
        .and_then(Value::as_f64)
        .unwrap_or(0.2);
    let store = MemoStore::open(&MemoStore::default_path()).map_err(failed)?;
    let memos = store.all().map_err(failed)?;
    let ranked = rank_memos(&memos, query, min_score, limit, None, None);
    let memories = ranked
        .into_iter()
        .map(|scored| {
            json!({
                "score": scored.score,
                "memo": serde_json::to_value(scored.memo).unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"memories": memories}))
}

fn memory_delete(params: &Value) -> Result<Value, RpcError> {
    let id = require_str(params, "id")?;
    let store = MemoStore::open(&MemoStore::default_path()).map_err(failed)?;
    let deleted = store.delete(id).map_err(failed)?;
    Ok(json!({"deleted": deleted}))
}

fn mcp_not_spawned(params: &Value) -> Result<Value, RpcError> {
    let name = require_str(params, "name")?;
    Ok(json!({
        "name": name,
        "connected": false,
        "detail": "the app-server reads mcp.json and does not spawn MCP servers",
    }))
}

fn status_json(status: ComputerUseStatus) -> Value {
    let mut value = json!({
        "phase": match status.phase {
            ComputerUsePhase::Idle => "idle",
            ComputerUsePhase::Starting => "starting",
            ComputerUsePhase::Active => "active",
            ComputerUsePhase::Failed => "failed",
        },
        "providerId": status.provider_id,
        "label": status.label,
        "serverName": status.server_name,
        "toolCount": status.tool_count,
        "permissionMode": match status.permission_mode {
            ComputerUsePermissionMode::Standard => "standard",
            ComputerUsePermissionMode::Bounded => "bounded",
            ComputerUsePermissionMode::Unrestricted => "unrestricted",
        },
    });
    if let Some(error) = status.error {
        value["error"] = json!(error);
    }
    value
}

fn require_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::params(format!("missing `{key}`")))
}

fn failed(error: impl ToString) -> RpcError {
    RpcError::failed(error.to_string())
}

fn id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_default()
}

async fn send_value(out: &Out, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    line.push('\n');
    let mut guard = out.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    guard.flush().await.map_err(|error| error.to_string())?;
    Ok(())
}

/// Read JSON-RPC requests from stdin and write responses to stdout.
pub async fn serve_stdio() -> anyhow::Result<()> {
    let stdin = BufReader::new(tokio::io::stdin());
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let pending_reader = Arc::clone(&pending);
    tokio::spawn(async move {
        let mut lines = stdin.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("app-server: invalid json: {error}");
                    continue;
                }
            };
            if value.get("method").is_some() {
                let _ = tx.send(value);
            } else if let Some(id) = value.get("id") {
                let key = id_key(id);
                if let Some(sender) = pending_reader.lock().await.remove(&key) {
                    let _ = sender.send(value);
                }
            }
        }
    });
    let mut server = Server::new(stdout, pending);
    while let Some(message) = rx.recv().await {
        server.handle(message).await;
    }
    Ok(())
}
