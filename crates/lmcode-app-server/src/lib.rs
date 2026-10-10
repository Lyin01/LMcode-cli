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
use lmcode_core::background::BackgroundTaskManager;
use lmcode_core::computer_use::{
    ComputerUseActivation, ComputerUseController, ComputerUseHost, ComputerUseLaunch,
    ComputerUsePhase, ComputerUseServerView, ComputerUseStatus, HostPlatform,
};
use lmcode_core::config::{
    ComputerUseConfig, ComputerUsePermissionMode, FileSandboxMode, LoopControlConfig,
    PermissionConfig, PermissionMode, RawConfig, RawModelAlias, RawProvider, default_config_path,
    load_config, resolve_model, save_config,
};
use lmcode_core::cron::{CronStore, CronTask, render_cron_fire_xml};
use lmcode_core::error::CoreError;
use lmcode_core::goal::{GoalMode, GoalStatus};
use lmcode_core::session::{DesktopWorktree, Session, SessionState, SessionStore};
use lmcode_core::skill::{SkillSource, discover_skills};
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
    background: Arc<BackgroundTaskManager>,
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
        // Desktop approval dialogs stay open while the operator reads the
        // command. 60s was shorter than a normal review.
        match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
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
            "thread/setModel" => self.thread_set_model(params).await,
            "thread/setThinking" => self.thread_set_thinking(params).await,
            "thread/setPermission" => self.thread_set_permission(params).await,
            "thread/setPlanMode" => self.thread_set_plan_mode(params).await,
            "thread/undo" => self.thread_undo(params).await,
            "thread/compact" => self.thread_compact(params).await,
            "skills/list" => self.skills_list(),
            "skills/activate" => self.skills_activate(params).await,
            "background/list" => self.background_list(params),
            "background/output" => self.background_output(params),
            "background/stop" => self.background_stop(params),
            "turn/start" => self.turn_start(params).await,
            "turn/steer" => self.turn_steer(params),
            "turn/interrupt" => self.turn_interrupt(),
            "config/read" => config_read(params),
            "config/write" => config_write(params),
            "config/get" => config_get(params),
            "config/patch" => config_patch(params),
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
        let mut session = SessionStore::new()
            .create(Path::new(cwd), model)
            .map_err(failed)?;
        apply_start_controls(&mut session, params)?;
        let active = open_thread(Path::new(cwd), model, session).await?;
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
        let active = open_thread(&cwd, &model, session).await?;
        let view = load_thread(&cwd, id)?;
        self.active = Some(active);
        Ok(json!({"thread": view}))
    }

    fn thread_list(&self, params: &Value) -> Result<Value, RpcError> {
        let store = SessionStore::new();
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty());
        let states = match cwd {
            Some(cwd) => store.list(Path::new(cwd)).map_err(failed)?,
            None => store.list_all().map_err(failed)?,
        };
        let threads = states
            .into_iter()
            .map(|state| {
                let dir = store.directory_of(&state);
                thread_body(&state, &dir)
            })
            .collect::<Vec<_>>();
        Ok(json!({"threads": threads}))
    }

    async fn thread_fork(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let cwd = PathBuf::from(require_str(params, "cwd")?);
        let source = require_str(params, "threadId")?.to_string();
        let target = format!("session_{}", uuid::Uuid::new_v4());
        let target_cwd = params
            .get("targetCwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        let title = params.get("title").and_then(Value::as_str);
        let worktree = desktop_worktree_from(params)?;
        let forked = SessionStore::new()
            .fork_into(&cwd, &source, &target_cwd, &target, title, worktree)
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
            let session = SessionStore::new().load(&cwd, &id).map_err(failed)?;
            let model = session.state.model.clone();
            self.active = Some(open_thread(&cwd, &model, session).await?);
        }
        let session = SessionStore::new().load(&cwd, &id).map_err(failed)?;
        Ok(json!({"thread": session_value(&session)?}))
    }

    async fn thread_set_model(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let model = require_str(params, "model")?.trim();
        if model.is_empty() {
            return Err(RpcError::params("Session model cannot be empty"));
        }
        let model = model.to_string();
        let provider = build_provider(&model)?;
        let (cwd, id) = {
            let active = self
                .active
                .as_ref()
                .ok_or_else(|| RpcError::failed("no active thread"))?;
            let cwd = active.cwd.clone();
            let id = active.id.clone();
            let mut agent = active.agent.lock().await;
            agent.persist_model(&model).map_err(failed)?;
            agent.set_provider(provider);
            (cwd, id)
        };
        if let Some(active) = self.active.as_mut() {
            active.model = model;
        }
        Ok(json!({"thread": load_thread(&cwd, &id)?}))
    }

    async fn thread_set_thinking(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let level = require_str(params, "level")?.trim();
        if level.is_empty() {
            return Err(RpcError::params("Session thinking level cannot be empty"));
        }
        let level = level.to_string();
        self.with_active_agent(|agent| agent.persist_thinking(&level))
            .await
    }

    async fn thread_set_permission(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let mode = require_str(params, "mode")?.trim();
        let Some(parsed) = permission_mode_from(mode) else {
            return Err(RpcError::params(
                "Session permission mode must be yolo, manual, or auto",
            ));
        };
        let mode = mode.to_string();
        self.with_active_agent(|agent| {
            agent.persist_permission(&mode)?;
            agent.set_permission_mode(parsed);
            Ok(())
        })
        .await
    }

    async fn thread_set_plan_mode(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let enabled = require_bool(params, "enabled")?;
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?;
        let cwd = active.cwd.clone();
        let id = active.id.clone();
        {
            let mut agent = active.agent.lock().await;
            agent.persist_plan_mode(enabled).map_err(failed)?;
            if let Err(error) = apply_stored_plan_mode(&mut agent, enabled).await {
                let _ = agent.persist_plan_mode(!enabled);
                return Err(error);
            }
        }
        Ok(json!({"thread": load_thread(&cwd, &id)?}))
    }

    async fn thread_undo(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let count = params.get("count").and_then(Value::as_u64).unwrap_or(1) as usize;
        self.with_active_agent(|agent| {
            agent.undo(count);
            agent.save_session()
        })
        .await
    }

    async fn thread_compact(&mut self, params: &Value) -> Result<Value, RpcError> {
        self.ensure_idle()?;
        let instruction = params
            .get("instruction")
            .and_then(Value::as_str)
            .map(str::to_string);
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?;
        let cwd = active.cwd.clone();
        let id = active.id.clone();
        let outcome = {
            let mut agent = active.agent.lock().await;
            agent
                .compact_now(instruction.as_deref())
                .await
                .map_err(failed)?
        };
        let _ = send_value(
            &self.out,
            &json!({
                "jsonrpc": "2.0",
                "method": "compaction/completed",
                "params": {
                    "threadId": id,
                    "result": {
                        "summary": outcome.summary,
                        "compactedCount": outcome.compacted_count,
                        "tokensBefore": outcome.tokens_before,
                        "tokensAfter": outcome.tokens_after,
                    }
                }
            }),
        )
        .await;
        Ok(json!({"thread": load_thread(&cwd, &id)?}))
    }

    fn skills_list(&self) -> Result<Value, RpcError> {
        let cwd = &self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?
            .cwd;
        let skills = discover_skills(cwd)
            .into_iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "description": skill.description,
                    "path": skill.path.display().to_string(),
                    "source": match skill.source {
                        SkillSource::Project => "project",
                        SkillSource::User => "user",
                    },
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"skills": skills}))
    }

    async fn skills_activate(&mut self, params: &Value) -> Result<Value, RpcError> {
        let name = require_str(params, "name")?.trim().to_string();
        if name.is_empty() {
            return Err(RpcError::params("Skill name cannot be empty"));
        }
        let args = params
            .get("args")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?;
        if active.running.load(Ordering::SeqCst) {
            return Err(RpcError::failed("a turn is already running"));
        }
        let skill = discover_skills(&active.cwd)
            .into_iter()
            .find(|skill| skill.name == name)
            .ok_or_else(|| RpcError::failed(format!("Skill \"{name}\" was not found")))?;
        let mut text = skill.load_body().map_err(RpcError::failed)?;
        if text.trim().is_empty() {
            return Err(RpcError::failed(format!(
                "Skill \"{name}\" has no instructions"
            )));
        }
        if let Some(args) = args {
            text.push_str("\n\n");
            text.push_str(&args);
        }
        let thread_id = {
            let active = self.active.as_ref().expect("active thread");
            if active.running.swap(true, Ordering::SeqCst) {
                return Err(RpcError::failed("a turn is already running"));
            }
            active.id.clone()
        };
        let turn_id = self.spawn_turn(text);
        Ok(json!({
            "activated": true,
            "name": name,
            "threadId": thread_id,
            "turnId": turn_id,
        }))
    }

    fn background_list(&self, params: &Value) -> Result<Value, RpcError> {
        let manager = self.background_manager()?;
        let active_only = params
            .get("activeOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut tasks = manager.list();
        if active_only {
            tasks.retain(|task| !task.status.is_terminal());
        }
        Ok(json!({"tasks": tasks}))
    }

    fn background_output(&self, params: &Value) -> Result<Value, RpcError> {
        let task_id = require_str(params, "taskId")?;
        if task_id.is_empty() {
            return Err(RpcError::params("Task id cannot be empty"));
        }
        let info = self
            .background_manager()?
            .get(task_id)
            .ok_or_else(|| RpcError::failed(format!("unknown background task `{task_id}`")))?;
        Ok(json!({"output": info.output}))
    }

    fn background_stop(&self, params: &Value) -> Result<Value, RpcError> {
        let task_id = require_str(params, "taskId")?;
        if task_id.is_empty() {
            return Err(RpcError::params("Task id cannot be empty"));
        }
        let reason = params
            .get("reason")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("Stopped from LMCODE Desktop");
        match self.background_manager()?.stop(task_id, reason) {
            Ok(info) => Ok(json!({"task": info})),
            Err(error) if error.contains("is not running") => Ok(json!({"stopped": false})),
            Err(error) => Err(RpcError::failed(error)),
        }
    }

    fn background_manager(&self) -> Result<Arc<BackgroundTaskManager>, RpcError> {
        self.active
            .as_ref()
            .map(|active| Arc::clone(&active.background))
            .ok_or_else(|| RpcError::failed("no active thread"))
    }

    /// Persist a control on the active thread and return its thread view.
    async fn with_active_agent(
        &mut self,
        change: impl FnOnce(&mut Agent) -> Result<(), CoreError>,
    ) -> Result<Value, RpcError> {
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| RpcError::failed("no active thread"))?;
        let cwd = active.cwd.clone();
        let id = active.id.clone();
        {
            let mut agent = active.agent.lock().await;
            change(&mut agent).map_err(failed)?;
        }
        Ok(json!({"thread": load_thread(&cwd, &id)?}))
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
        let thread_id = active.id.clone();
        let turn_id = self.spawn_turn(text);
        Ok(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "status": "started",
        }))
    }

    /// `running` is already true. The turn task clears it when the model returns.
    fn spawn_turn(&mut self, text: String) -> String {
        let active = self
            .active
            .as_ref()
            .expect("spawn_turn requires an active thread");
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
        turn_id
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
        let jobs = tasks.iter().map(job_value).collect::<Vec<_>>();
        Ok(json!({"tasks": jobs}))
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
        Ok(json!({"task": job_value(&task)}))
    }

    async fn cron_delete(&self, params: &Value) -> Result<Value, RpcError> {
        let cron = self.cron_handle()?;
        let id = require_str(params, "id")?;
        let deleted = cron.lock().await.remove(id);
        Ok(json!({"deleted": deleted}))
    }

    async fn notify(&self, method: &str, params: Value) {
        let _ = send_value(
            &self.out,
            &json!({"jsonrpc": "2.0", "method": method, "params": params}),
        )
        .await;
    }

    /// Deliver due jobs on the active thread. A running turn keeps the jobs
    /// due so the next idle beat can start them. Matches the TUI tick:
    /// inject `<cron-fire>` and run one turn.
    async fn cron_tick(&mut self) {
        let (thread_id, cron, running, agent) = {
            let Some(active) = self.active.as_ref() else {
                return;
            };
            if active.running.load(Ordering::SeqCst) {
                return;
            }
            (
                active.id.clone(),
                Arc::clone(&active.cron),
                Arc::clone(&active.running),
                Arc::clone(&active.agent),
            )
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let fires = cron.lock().await.due_fires(now_ms);
        if fires.is_empty() {
            return;
        }
        // The request loop cannot start a turn while this beat is in progress.
        // If a turn is still marked running, leave the prompts on the steer
        // slot and do not start a second one. due_fires already consumed them,
        // so they have to be delivered here.
        if running.swap(true, Ordering::SeqCst) {
            if let Some(active) = self.active.as_ref() {
                for fire in &fires {
                    let _ = active.steer.submit(&render_cron_fire_xml(fire));
                }
            }
            for fire in &fires {
                self.notify_cron(&thread_id, fire).await;
            }
            return;
        }
        for fire in &fires {
            self.notify_cron(&thread_id, fire).await;
        }
        {
            let mut agent = agent.lock().await;
            for fire in &fires {
                agent.queue_injection(render_cron_fire_xml(fire));
            }
        }
        self.spawn_turn("A scheduled task has fired — handle it.".to_string());
    }

    async fn notify_cron(&self, thread_id: &str, fire: &lmcode_core::cron::CronFire) {
        self.notify(
            "cron/fired",
            json!({
                "threadId": thread_id,
                "prompt": fire.prompt,
                "origin": {
                    "kind": "cron_job",
                    "jobId": fire.task_id,
                    "cron": fire.cron,
                    "recurring": fire.recurring,
                    "coalescedCount": 1,
                    "stale": fire.stale,
                },
            }),
        )
        .await;
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

async fn open_thread(cwd: &Path, model: &str, session: Session) -> Result<ActiveThread, RpcError> {
    let provider = build_provider(model)?;
    let directory = session.directory().to_path_buf();
    let background = Arc::new(BackgroundTaskManager::new(directory.join("tasks")));
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(BashTool::with_background(Arc::clone(&background))),
        Arc::new(AskUserQuestionTool::new()),
    ];
    let mut agent = Agent::new(provider, tools, "You are LMcode.", cwd.to_path_buf());
    if let Ok(config) = load_config(None) {
        agent.apply_permission_config(&config);
    }
    if let Some(mode) = session
        .state
        .permission
        .as_deref()
        .and_then(permission_mode_from)
    {
        agent.set_permission_mode(mode);
    }
    let plan_mode = session.state.plan_mode;
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
    apply_stored_plan_mode(&mut agent, plan_mode).await?;
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
        background,
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

fn thread_body(state: &SessionState, session_dir: &Path) -> Value {
    json!({
        "id": state.id,
        "cwd": state.work_dir,
        "model": state.model,
        "title": state.title,
        "thinking": state.thinking,
        "permission": effective_permission(state.permission.as_deref()),
        "planMode": state.plan_mode,
        "forkedFrom": state.forked_from,
        "createdAt": state.created_at,
        "updatedAt": state.updated_at,
        "sessionDir": session_dir.display().to_string(),
        "desktopWorktree": state.desktop_worktree,
    })
}

fn session_value(session: &Session) -> Result<Value, RpcError> {
    let mut value = thread_body(&session.state, session.directory());
    value["messages"] = serde_json::to_value(&session.messages).map_err(failed)?;
    Ok(value)
}

fn job_value(task: &CronTask) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut value = json!({
        "id": task.id,
        "cron": task.cron,
        "prompt": task.prompt,
        "createdAt": task.created_at,
        "recurring": task.is_recurring(),
        "humanSchedule": task.cron,
        "nextFireAt": task.next_fire_at_ms(),
        "stale": task.is_stale_at(now_ms),
    });
    if let Some(last) = task.last_fired_at {
        value["lastFiredAt"] = json!(last);
    }
    value
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

/// CamelCase view of the modeled config plus unknown keys kept in `extra`.
///
/// A missing file is an empty config (`providers: {}`) so the settings panel
/// can render before the desktop writes the first file. `config/read` still
/// errors when the file is absent.
fn config_get(params: &Value) -> Result<Value, RpcError> {
    let path = config_path(params);
    let config = match load_config(Some(&path)) {
        Ok(config) => config,
        Err(_) if !path.exists() => RawConfig::default(),
        Err(error) => return Err(failed(error)),
    };
    config_to_json(&config)
}

/// Merge a camelCase patch into the file and return the same shape as [`config_get`].
///
/// Provider and model entries merge by id. A JSON null deletes that entry.
/// Keys this schema does not model are stored as-is so a desktop startup flag
/// such as `anchoredBootstrap` round-trips.
fn config_patch(params: &Value) -> Result<Value, RpcError> {
    let path = config_path(params);
    let patch = params
        .get("patch")
        .cloned()
        .unwrap_or_else(|| params.clone());
    let patch = patch
        .as_object()
        .ok_or_else(|| RpcError::params("config patch must be an object"))?;
    let mut config = match load_config(Some(&path)) {
        Ok(config) => config,
        Err(_) if !path.exists() => RawConfig::default(),
        Err(error) => return Err(failed(error)),
    };
    apply_config_patch(&mut config, patch)?;
    let backup = std::fs::read(&path).ok();
    save_config(&path, &config).map_err(failed)?;
    match load_config(Some(&path)) {
        Ok(loaded) => config_to_json(&loaded),
        Err(error) => {
            if let Some(bytes) = backup {
                let _ = std::fs::write(&path, bytes);
            } else {
                let _ = std::fs::remove_file(&path);
            }
            Err(failed(error))
        }
    }
}

fn config_to_json(config: &RawConfig) -> Result<Value, RpcError> {
    let mut value = serde_json::Map::new();
    value.insert("providers".to_string(), providers_json(&config.providers));
    insert_json_string(
        &mut value,
        "defaultProvider",
        config.default_provider.as_deref(),
    );
    insert_json_string(&mut value, "defaultModel", config.default_model.as_deref());
    if !config.models.is_empty() {
        value.insert("models".to_string(), models_json(&config.models));
    }
    if let Some(thinking) = config.default_thinking {
        value.insert("defaultThinking".to_string(), json!(thinking));
    }
    if let Some(mode) = config.default_permission_mode {
        value.insert(
            "defaultPermissionMode".to_string(),
            serde_json::to_value(mode).map_err(failed)?,
        );
    }
    if let Some(sandbox) = config.default_file_sandbox {
        value.insert(
            "defaultFileSandbox".to_string(),
            serde_json::to_value(sandbox).map_err(failed)?,
        );
    }
    if let Some(permission) = &config.permission
        && !permission.rules.is_empty()
    {
        value.insert(
            "permission".to_string(),
            serde_json::to_value(permission).map_err(failed)?,
        );
    }
    if let Some(loop_control) = &config.loop_control {
        let encoded = loop_control_json(loop_control);
        if encoded.as_object().is_some_and(|object| !object.is_empty()) {
            value.insert("loopControl".to_string(), encoded);
        }
    }
    if let Some(computer_use) = &config.computer_use {
        value.insert("computerUse".to_string(), computer_use_json(computer_use)?);
    }
    for (key, extra) in &config.extra {
        if value.contains_key(key) {
            continue;
        }
        value.insert(key.clone(), toml_to_json(extra));
    }
    Ok(Value::Object(value))
}

fn apply_config_patch(
    config: &mut RawConfig,
    patch: &serde_json::Map<String, Value>,
) -> Result<(), RpcError> {
    for (key, value) in patch {
        match key.as_str() {
            "path" | "patch" => {}
            "providers" => merge_providers(&mut config.providers, value)?,
            "models" => merge_models(&mut config.models, value)?,
            "defaultProvider" => config.default_provider = optional_string(value)?,
            "defaultModel" => config.default_model = optional_string(value)?,
            "defaultThinking" => {
                config.default_thinking = match value {
                    Value::Null => None,
                    Value::Bool(flag) => Some(*flag),
                    _ => return Err(RpcError::params("defaultThinking must be a boolean")),
                }
            }
            "defaultPermissionMode" => {
                config.default_permission_mode = match value {
                    Value::Null => None,
                    Value::String(name) => Some(parse_permission_mode(name)?),
                    _ => return Err(RpcError::params("defaultPermissionMode must be a string")),
                }
            }
            "defaultFileSandbox" => {
                config.default_file_sandbox = match value {
                    Value::Null => None,
                    Value::String(name) => Some(parse_file_sandbox(name)?),
                    _ => return Err(RpcError::params("defaultFileSandbox must be a string")),
                }
            }
            "permission" => {
                config.permission = match value {
                    Value::Null => None,
                    other => Some(
                        serde_json::from_value::<PermissionConfig>(other.clone())
                            .map_err(failed)?,
                    ),
                }
            }
            "loopControl" => merge_loop_control(config, value)?,
            "computerUse" => merge_computer_use(config, value)?,
            other => {
                if value.is_null() {
                    config.extra.remove(other);
                } else {
                    config.extra.insert(other.to_string(), json_to_toml(value)?);
                }
            }
        }
    }
    Ok(())
}

fn providers_json(providers: &HashMap<String, RawProvider>) -> Value {
    let mut object = serde_json::Map::new();
    for (id, provider) in providers {
        object.insert(id.clone(), provider_json(provider));
    }
    Value::Object(object)
}

fn provider_json(provider: &RawProvider) -> Value {
    let mut value = serde_json::Map::new();
    if !provider.provider_type.is_empty() {
        value.insert("type".to_string(), json!(provider.provider_type));
    }
    insert_json_string(&mut value, "apiKey", provider.api_key.as_deref());
    insert_json_string(&mut value, "baseUrl", provider.base_url.as_deref());
    insert_json_string(
        &mut value,
        "defaultModel",
        provider.default_model.as_deref(),
    );
    if !provider.custom_headers.is_empty() {
        value.insert(
            "customHeaders".to_string(),
            serde_json::to_value(&provider.custom_headers).unwrap_or(json!({})),
        );
    }
    if let Some(enabled) = provider.enabled {
        value.insert("enabled".to_string(), json!(enabled));
    }
    insert_json_string(&mut value, "project", provider.project.as_deref());
    insert_json_string(&mut value, "location", provider.location.as_deref());
    insert_json_string(&mut value, "credentials", provider.credentials.as_deref());
    Value::Object(value)
}

fn models_json(models: &HashMap<String, RawModelAlias>) -> Value {
    let mut object = serde_json::Map::new();
    for (id, alias) in models {
        let mut value = serde_json::Map::new();
        value.insert("provider".to_string(), json!(alias.provider));
        value.insert("model".to_string(), json!(alias.model));
        if let Some(size) = alias.max_context_size {
            value.insert("maxContextSize".to_string(), json!(size));
        }
        if let Some(size) = alias.max_output_size {
            value.insert("maxOutputSize".to_string(), json!(size));
        }
        insert_json_string(&mut value, "displayName", alias.display_name.as_deref());
        object.insert(id.clone(), Value::Object(value));
    }
    Value::Object(object)
}

fn loop_control_json(loop_control: &LoopControlConfig) -> Value {
    let mut value = serde_json::Map::new();
    insert_json_u64(
        &mut value,
        "maxStepsPerTurn",
        loop_control.max_steps_per_turn,
    );
    insert_json_u64(
        &mut value,
        "maxRetriesPerStep",
        loop_control.max_retries_per_step,
    );
    if let Some(iterations) = loop_control.max_ralph_iterations {
        value.insert("maxRalphIterations".to_string(), json!(iterations));
    }
    insert_json_u64(
        &mut value,
        "maxPostWriteReviewsPerTurn",
        loop_control.max_post_write_reviews_per_turn,
    );
    insert_json_u64(
        &mut value,
        "reservedContextSize",
        loop_control.reserved_context_size,
    );
    if let Some(ratio) = loop_control.compaction_trigger_ratio {
        value.insert("compactionTriggerRatio".to_string(), json!(ratio));
    }
    insert_json_u64(
        &mut value,
        "mediaBudgetBytes",
        loop_control.media_budget_bytes,
    );
    insert_json_u64(
        &mut value,
        "mediaToolResultImageLimit",
        loop_control.media_tool_result_image_limit,
    );
    insert_json_u64(
        &mut value,
        "microCompactionWorkingSetTokens",
        loop_control.micro_compaction_working_set_tokens,
    );
    insert_json_u64(
        &mut value,
        "compactionBlockTimeoutMs",
        loop_control.compaction_block_timeout_ms,
    );
    Value::Object(value)
}

fn computer_use_json(computer_use: &ComputerUseConfig) -> Result<Value, RpcError> {
    let mut value = serde_json::Map::new();
    value.insert("enabled".to_string(), json!(computer_use.enabled));
    insert_json_string(&mut value, "provider", computer_use.provider.as_deref());
    insert_json_string(&mut value, "command", computer_use.command.as_deref());
    if !computer_use.args.is_empty() {
        value.insert("args".to_string(), json!(computer_use.args));
    }
    if let Some(mode) = computer_use.permission_mode {
        value.insert(
            "permissionMode".to_string(),
            serde_json::to_value(mode).map_err(failed)?,
        );
    }
    Ok(Value::Object(value))
}

fn merge_providers(
    providers: &mut HashMap<String, RawProvider>,
    value: &Value,
) -> Result<(), RpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::params("providers must be an object"))?;
    for (id, entry) in object {
        if entry.is_null() {
            providers.remove(id);
            continue;
        }
        let entry = entry
            .as_object()
            .ok_or_else(|| RpcError::params("provider entry must be an object"))?;
        let mut provider = providers.get(id).cloned().unwrap_or_default();
        if let Some(kind) = entry.get("type").and_then(Value::as_str) {
            provider.provider_type = kind.to_string();
        }
        assign_optional_string(&mut provider.api_key, entry.get("apiKey"))?;
        assign_optional_string(&mut provider.base_url, entry.get("baseUrl"))?;
        assign_optional_string(&mut provider.default_model, entry.get("defaultModel"))?;
        assign_optional_string(&mut provider.project, entry.get("project"))?;
        assign_optional_string(&mut provider.location, entry.get("location"))?;
        assign_optional_string(&mut provider.credentials, entry.get("credentials"))?;
        if let Some(headers) = entry.get("customHeaders") {
            provider.custom_headers = serde_json::from_value(headers.clone()).map_err(failed)?;
        }
        if let Some(enabled) = entry.get("enabled") {
            provider.enabled = match enabled {
                Value::Null => None,
                Value::Bool(flag) => Some(*flag),
                _ => return Err(RpcError::params("provider enabled must be a boolean")),
            };
        }
        providers.insert(id.clone(), provider);
    }
    Ok(())
}

fn merge_models(
    models: &mut HashMap<String, RawModelAlias>,
    value: &Value,
) -> Result<(), RpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::params("models must be an object"))?;
    for (id, entry) in object {
        if entry.is_null() {
            models.remove(id);
            continue;
        }
        let entry = entry
            .as_object()
            .ok_or_else(|| RpcError::params("model entry must be an object"))?;
        let mut alias = models.get(id).cloned().unwrap_or_default();
        if let Some(provider) = entry.get("provider").and_then(Value::as_str) {
            alias.provider = provider.to_string();
        }
        if let Some(model) = entry.get("model").and_then(Value::as_str) {
            alias.model = model.to_string();
        }
        if let Some(size) = entry.get("maxContextSize") {
            alias.max_context_size = optional_u64(size)?;
        }
        if let Some(size) = entry.get("maxOutputSize") {
            alias.max_output_size = optional_u64(size)?;
        }
        assign_optional_string(&mut alias.display_name, entry.get("displayName"))?;
        models.insert(id.clone(), alias);
    }
    Ok(())
}

fn merge_loop_control(config: &mut RawConfig, value: &Value) -> Result<(), RpcError> {
    if value.is_null() {
        config.loop_control = None;
        return Ok(());
    }
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::params("loopControl must be an object"))?;
    let mut section = config.loop_control.clone().unwrap_or_default();
    assign_optional_u64(
        &mut section.max_steps_per_turn,
        object.get("maxStepsPerTurn"),
    )?;
    assign_optional_u64(
        &mut section.max_retries_per_step,
        object.get("maxRetriesPerStep"),
    )?;
    if let Some(iterations) = object.get("maxRalphIterations") {
        section.max_ralph_iterations = match iterations {
            Value::Null => None,
            Value::Number(number) => Some(
                number
                    .as_i64()
                    .ok_or_else(|| RpcError::params("maxRalphIterations must be an integer"))?,
            ),
            _ => return Err(RpcError::params("maxRalphIterations must be an integer")),
        };
    }
    assign_optional_u64(
        &mut section.max_post_write_reviews_per_turn,
        object.get("maxPostWriteReviewsPerTurn"),
    )?;
    assign_optional_u64(
        &mut section.reserved_context_size,
        object.get("reservedContextSize"),
    )?;
    if let Some(ratio) = object.get("compactionTriggerRatio") {
        section.compaction_trigger_ratio = match ratio {
            Value::Null => None,
            Value::Number(number) => Some(
                number
                    .as_f64()
                    .ok_or_else(|| RpcError::params("compactionTriggerRatio must be a number"))?,
            ),
            _ => return Err(RpcError::params("compactionTriggerRatio must be a number")),
        };
    }
    assign_optional_u64(
        &mut section.media_budget_bytes,
        object.get("mediaBudgetBytes"),
    )?;
    assign_optional_u64(
        &mut section.media_tool_result_image_limit,
        object.get("mediaToolResultImageLimit"),
    )?;
    assign_optional_u64(
        &mut section.micro_compaction_working_set_tokens,
        object.get("microCompactionWorkingSetTokens"),
    )?;
    assign_optional_u64(
        &mut section.compaction_block_timeout_ms,
        object.get("compactionBlockTimeoutMs"),
    )?;
    config.loop_control = Some(section);
    Ok(())
}

fn merge_computer_use(config: &mut RawConfig, value: &Value) -> Result<(), RpcError> {
    if value.is_null() {
        config.computer_use = None;
        return Ok(());
    }
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::params("computerUse must be an object"))?;
    let mut section = config.computer_use.clone().unwrap_or(ComputerUseConfig {
        enabled: false,
        provider: None,
        command: None,
        args: Vec::new(),
        permission_mode: None,
    });
    if let Some(enabled) = object.get("enabled") {
        section.enabled = enabled
            .as_bool()
            .ok_or_else(|| RpcError::params("computerUse.enabled must be a boolean"))?;
    }
    assign_optional_string(&mut section.provider, object.get("provider"))?;
    assign_optional_string(&mut section.command, object.get("command"))?;
    if let Some(args) = object.get("args") {
        section.args = serde_json::from_value(args.clone()).map_err(failed)?;
    }
    if let Some(mode) = object.get("permissionMode") {
        section.permission_mode = match mode {
            Value::Null => None,
            Value::String(name) => Some(parse_computer_use_mode(name)?),
            _ => {
                return Err(RpcError::params(
                    "computerUse.permissionMode must be a string",
                ));
            }
        };
    }
    config.computer_use = Some(section);
    Ok(())
}

fn parse_permission_mode(name: &str) -> Result<PermissionMode, RpcError> {
    match name {
        "manual" => Ok(PermissionMode::Manual),
        "yolo" => Ok(PermissionMode::Yolo),
        "auto" => Ok(PermissionMode::Auto),
        other => Err(RpcError::params(format!(
            "unknown permission mode `{other}`"
        ))),
    }
}

fn parse_file_sandbox(name: &str) -> Result<FileSandboxMode, RpcError> {
    match name {
        "read-only" => Ok(FileSandboxMode::ReadOnly),
        "workspace-write" => Ok(FileSandboxMode::WorkspaceWrite),
        "full-access" => Ok(FileSandboxMode::FullAccess),
        other => Err(RpcError::params(format!("unknown file sandbox `{other}`"))),
    }
}

fn parse_computer_use_mode(name: &str) -> Result<ComputerUsePermissionMode, RpcError> {
    match name {
        "standard" => Ok(ComputerUsePermissionMode::Standard),
        "bounded" => Ok(ComputerUsePermissionMode::Bounded),
        "unrestricted" => Ok(ComputerUsePermissionMode::Unrestricted),
        other => Err(RpcError::params(format!(
            "unknown computer-use permission mode `{other}`"
        ))),
    }
}

fn optional_string(value: &Value) -> Result<Option<String>, RpcError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(RpcError::params("expected a string or null")),
    }
}

fn assign_optional_string(
    slot: &mut Option<String>,
    value: Option<&Value>,
) -> Result<(), RpcError> {
    let Some(value) = value else {
        return Ok(());
    };
    *slot = optional_string(value)?;
    Ok(())
}

fn optional_u64(value: &Value) -> Result<Option<u64>, RpcError> {
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| RpcError::params("expected a non-negative integer")),
        _ => Err(RpcError::params("expected a non-negative integer")),
    }
}

fn assign_optional_u64(slot: &mut Option<u64>, value: Option<&Value>) -> Result<(), RpcError> {
    let Some(value) = value else {
        return Ok(());
    };
    *slot = optional_u64(value)?;
    Ok(())
}

fn insert_json_string(object: &mut serde_json::Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        object.insert(key.to_string(), json!(value));
    }
}

fn insert_json_u64(object: &mut serde_json::Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        object.insert(key.to_string(), json!(value));
    }
}

fn toml_to_json(value: &toml::Value) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn json_to_toml(value: &Value) -> Result<toml::Value, RpcError> {
    match value {
        Value::Null => Err(RpcError::params("cannot store null as a config value")),
        Value::Bool(flag) => Ok(toml::Value::Boolean(*flag)),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(toml::Value::Integer(integer))
            } else if let Some(float) = number.as_f64() {
                Ok(toml::Value::Float(float))
            } else {
                Err(RpcError::params("config number is out of range"))
            }
        }
        Value::String(text) => Ok(toml::Value::String(text.clone())),
        Value::Array(items) => Ok(toml::Value::Array(
            items
                .iter()
                .map(json_to_toml)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Value::Object(object) => {
            let mut table = toml::map::Map::new();
            for (key, entry) in object {
                table.insert(key.clone(), json_to_toml(entry)?);
            }
            Ok(toml::Value::Table(table))
        }
    }
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

fn apply_start_controls(session: &mut Session, params: &Value) -> Result<(), RpcError> {
    let mut touched = false;
    if params.get("thinking").is_some() && !params["thinking"].is_null() {
        session
            .state
            .apply_thinking(require_str(params, "thinking")?)
            .map_err(failed)?;
        touched = true;
    }
    if params.get("permission").is_some() && !params["permission"].is_null() {
        session
            .state
            .apply_permission(require_str(params, "permission")?)
            .map_err(failed)?;
        touched = true;
    }
    if let Some(enabled) = params.get("planMode").and_then(Value::as_bool) {
        session.state.plan_mode = enabled;
        touched = true;
    }
    if touched {
        let messages = session.messages.clone();
        session.save(&messages).map_err(failed)?;
    }
    Ok(())
}

fn desktop_worktree_from(params: &Value) -> Result<Option<DesktopWorktree>, RpcError> {
    let Some(metadata) = params.get("metadata") else {
        return Ok(None);
    };
    if metadata.is_null() {
        return Ok(None);
    }
    let Some(worktree) = metadata.get("desktopWorktree") else {
        return Ok(None);
    };
    if worktree.is_null() {
        return Ok(None);
    }
    let branch = require_nonempty(worktree, "branch")?;
    let path = require_nonempty(worktree, "path")?;
    let source = require_nonempty(worktree, "sourceSessionId")?;
    Ok(Some(DesktopWorktree {
        branch: branch.to_string(),
        path: path.to_string(),
        source_session_id: source.to_string(),
    }))
}

fn require_nonempty<'a>(value: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| RpcError::params(format!("desktopWorktree.{key} is required")))?;
    Ok(text)
}

async fn apply_stored_plan_mode(agent: &mut Agent, enabled: bool) -> Result<(), RpcError> {
    let base = agent
        .session_directory()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let handle = agent.plan_handle();
    let mut plan = handle.lock().await;
    if enabled {
        if !plan.is_active() {
            plan.enter(&base, false)
                .map_err(|error| RpcError::failed(format!("failed to enter plan mode: {error}")))?;
        }
    } else if plan.is_active() {
        plan.exit();
    }
    Ok(())
}

fn permission_mode_from(text: &str) -> Option<PermissionMode> {
    match text {
        "manual" => Some(PermissionMode::Manual),
        "yolo" => Some(PermissionMode::Yolo),
        "auto" => Some(PermissionMode::Auto),
        _ => None,
    }
}

fn permission_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Manual => "manual",
        PermissionMode::Yolo => "yolo",
        PermissionMode::Auto => "auto",
    }
}

/// Stored override, otherwise the config default, otherwise `manual`.
fn effective_permission(stored: Option<&str>) -> String {
    if let Some(mode) = stored.filter(|mode| permission_mode_from(mode).is_some()) {
        return mode.to_string();
    }
    if let Ok(config) = load_config(None)
        && let Some(mode) = config.default_permission_mode
    {
        return permission_label(mode).to_string();
    }
    "manual".to_string()
}

fn require_bool(params: &Value, key: &str) -> Result<bool, RpcError> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::params(format!("missing `{key}`")))
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
    let mut cron_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    cron_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            message = rx.recv() => {
                let Some(message) = message else {
                    break;
                };
                server.handle(message).await;
            }
            _ = cron_tick.tick() => {
                server.cron_tick().await;
            }
        }
    }
    Ok(())
}
