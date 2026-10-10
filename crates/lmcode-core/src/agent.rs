//! Minimal agent turn loop — the Rust seed of `packages/agent-core`'s turn engine.
//!
//! One user turn: stream a model response, execute any requested tool calls
//! (asking for approval when required), feed the results back, and repeat
//! until the model replies without tool calls or the step limit is hit.

use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures_util::StreamExt;
use lmcode_llm::LlmError;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{
    ContentPart, ImageUrl, Message, MessageOrigin, Role, StreamedMessagePart, ToolCall,
};
use lmcode_llm::provider::{ChatProvider, GenerateOptions, StreamedMessage};
use lmcode_llm::tool::Tool as ToolDefinition;
use lmcode_memory::{
    EXIT_EXTRACTION_SYSTEM_PROMPT, MemoKind, MemoStore, PendingTaskRef,
    build_exit_extraction_prompt, parse_memory_memos, parse_resolved_pending_ids,
};

use crate::compaction::{
    CompactionPipeline, estimate_tokens, estimate_tokens_for_messages, render_messages,
};
use crate::config::{FileSandboxMode, PermissionMode, RawConfig};
use crate::error::CoreError;
use crate::permission::SessionApprovals;
use crate::permission_chain::{PermissionRequest, PermissionState, decide};
use crate::retry::{
    DEFAULT_MAX_RETRY_ATTEMPTS, chat_with_retry, is_context_overflow, is_retryable_llm_error,
};
use crate::session::Session;
use crate::tools::{Tool, ToolResult};

const DEFAULT_MAX_STEPS: usize = 50;

/// Buffer for text steered into an active turn.
///
/// `submit` returns false when no turn is running, so the caller can start
/// one. While a turn is running, the text waits here and the loop appends it
/// before the next model call.
pub struct SteerSlot {
    active: AtomicBool,
    pending: std::sync::Mutex<Vec<Message>>,
}

impl SteerSlot {
    fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            pending: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Queue `text` as a user prompt. Returns false when the agent is idle.
    pub fn submit(&self, text: &str) -> bool {
        if !self.active.load(Ordering::SeqCst) {
            return false;
        }
        self.pending
            .lock()
            .expect("steer lock")
            .push(user_prompt(text));
        true
    }

    fn activate(&self) {
        self.active.store(true, Ordering::SeqCst);
    }

    fn deactivate(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn take(&self) -> Vec<Message> {
        std::mem::take(&mut *self.pending.lock().expect("steer lock"))
    }

    fn clear(&self) {
        self.pending.lock().expect("steer lock").clear();
    }
}

struct TurnActiveGuard(Arc<SteerSlot>);

impl Drop for TurnActiveGuard {
    fn drop(&mut self) {
        self.0.deactivate();
    }
}

fn user_prompt(text: impl Into<String>) -> Message {
    Message::user(text).with_origin(MessageOrigin::User)
}

fn user_prompt_with_images(text: &str, images: &[String]) -> Message {
    if text.is_empty() {
        let content = images
            .iter()
            .map(|url| ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: url.clone(),
                    id: None,
                },
            })
            .collect();
        return Message {
            role: Role::User,
            name: None,
            content,
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
            origin: Some(MessageOrigin::User),
        };
    }
    Message::user_with_images(text, images).with_origin(MessageOrigin::User)
}

fn injection_message(text: impl Into<String>) -> Message {
    variant_injection(text, "host")
}

fn variant_injection(text: impl Into<String>, variant: &str) -> Message {
    Message::user(text).with_origin(MessageOrigin::Injection {
        variant: Some(variant.to_string()),
    })
}

/// UI sink the turn loop reports progress to.
#[async_trait]
pub trait TurnUi: Send {
    /// A chunk of assistant-visible text.
    async fn text_delta(&mut self, text: &str);
    /// A chunk of model reasoning ("think") text.
    async fn think_delta(&mut self, text: &str);
    /// A tool call is about to run.
    async fn tool_start(&mut self, name: &str, arguments: &str);
    /// A tool call finished; `ok` is false when it failed or was denied.
    /// `result` is a truncated view of the tool output (the model still gets
    /// the full output).
    async fn tool_end(&mut self, name: &str, ok: bool, result: &str);
    /// Ask the user to approve a tool call. Returning `false` denies it.
    async fn approve(&mut self, name: &str, arguments: &str) -> bool;
    /// Ask a structured question. The default client cannot show one.
    async fn ask_user(
        &mut self,
        questions: &[crate::tools::ask_user::UserQuestion],
    ) -> crate::tools::ask_user::AskUserAnswer {
        let _ = questions;
        crate::tools::ask_user::AskUserAnswer::Unsupported
    }
    /// A short informational notice (compaction, session events).
    async fn notice(&mut self, message: &str);
}

/// Wait for one Ctrl+C. If signal handling is unavailable, waits forever so
/// `select!` callers never mistake initialization failure for an interrupt.
pub async fn wait_for_ctrl_c() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Cap tool output forwarded to the UI (the model keeps the full output).
fn truncate_for_ui(output: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let total = output.chars().count();
    if total <= MAX_CHARS {
        return output.to_string();
    }
    let truncated: String = output.chars().take(MAX_CHARS).collect();
    format!("{truncated}\n… ({} more characters)", total - MAX_CHARS)
}

/// Outcome of one user turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnOutcome {
    /// Number of model steps executed.
    pub steps: usize,
    /// The turn was interrupted (Ctrl+C); its history was rolled back.
    pub interrupted: bool,
    /// The step limit was reached while the model still wanted tools.
    pub hit_step_limit: bool,
}

/// Result of a manual compaction. The history is already persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionOutcome {
    pub summary: String,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: u64,
}

/// One tool call inside a turn. Cancellation while waiting is not a tool error.
enum ToolExec {
    /// Output the model should see. `ok` is false when the call failed.
    Finished(ToolResult),
    /// The user cancelled while the tool was waiting. The turn rolls back.
    Interrupted,
}

/// Session permission posture consumed by [`decide`](crate::permission_chain::decide).
#[derive(Debug, Clone)]
struct PermissionRuntime {
    mode: PermissionMode,
    sandbox: FileSandboxMode,
    rules: Vec<crate::config::StoredPermissionRule>,
    session_patterns: Vec<String>,
    wolfpack_active: bool,
    subagent: bool,
}

impl Default for PermissionRuntime {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Manual,
            sandbox: FileSandboxMode::FullAccess,
            rules: Vec::new(),
            session_patterns: Vec::new(),
            wolfpack_active: false,
            subagent: false,
        }
    }
}

/// The agent: conversation history + provider + tools.
pub struct Agent {
    provider: Arc<dyn ChatProvider>,
    tools: Vec<Arc<dyn Tool>>,
    history: Vec<Message>,
    system_prompt: String,
    cwd: PathBuf,
    max_steps: usize,
    pipeline: CompactionPipeline,
    usage: crate::usage::UsageRecorder,
    plan: crate::tools::planning::PlanHandle,
    goal: crate::tools::goal::GoalHandle,
    cron: crate::tools::cron::CronHandle,
    /// Messages queued for injection before the next turn (cron fires).
    injections: Vec<String>,
    /// Shared snapshot of recent execution evidence (for the goal grader).
    evidence_snapshot: std::sync::Arc<tokio::sync::Mutex<String>>,
    /// Session running notes (post-compaction context retention).
    session_memory: crate::session_memory::SessionMemory,
    /// Turn-scoped reminder appended to the system prompt (session memory).
    turn_reminder: String,
    session: Option<Session>,
    cancel: Option<Arc<tokio::sync::Notify>>,
    approvals: SessionApprovals,
    /// Permission posture. The chain reads this on every tool call.
    permission: PermissionRuntime,
    /// Memo database shared with the memory tools. Absent when it failed to open.
    memo_store: Option<Arc<MemoStore>>,
    /// Fingerprint of the history snapshot last scanned by exit extraction.
    last_exit_fingerprint: Option<u64>,
    /// Set when a finished compaction could not store every parsed memo.
    compaction_memo_warning: Option<String>,
    /// Attempts per model call, including the first. Overflow is not retried.
    max_retries: u32,
    /// Shared with anything that needs to steer while `run_turn` holds `&mut self`.
    steer: Arc<SteerSlot>,
    /// When true, the turn restates the desktop operating contract.
    computer_use_active: bool,
    computer_use_injector: crate::injection::ComputerUseInjector,
    preferences_injector: crate::injection::UserPreferencesInjector,
    pending_injector: crate::injection::PendingTasksInjector,
}

impl Agent {
    pub fn new(
        provider: Arc<dyn ChatProvider>,
        tools: Vec<Arc<dyn Tool>>,
        system_prompt: impl Into<String>,
        cwd: PathBuf,
    ) -> Self {
        Self {
            provider,
            tools,
            history: Vec::new(),
            system_prompt: system_prompt.into(),
            cwd,
            max_steps: DEFAULT_MAX_STEPS,
            pipeline: CompactionPipeline::disabled(),
            usage: crate::usage::UsageRecorder::default(),
            plan: std::sync::Arc::new(tokio::sync::Mutex::new(crate::plan::PlanMode::default())),
            goal: std::sync::Arc::new(tokio::sync::Mutex::new(crate::goal::GoalMode::default())),
            cron: std::sync::Arc::new(tokio::sync::Mutex::new(crate::cron::CronStore::default())),
            injections: Vec::new(),
            evidence_snapshot: std::sync::Arc::new(tokio::sync::Mutex::new(String::new())),
            session_memory: crate::session_memory::SessionMemory::default(),
            turn_reminder: String::new(),
            session: None,
            cancel: None,
            approvals: SessionApprovals::default(),
            permission: PermissionRuntime::default(),
            memo_store: None,
            last_exit_fingerprint: None,
            compaction_memo_warning: None,
            max_retries: DEFAULT_MAX_RETRY_ATTEMPTS,
            steer: Arc::new(SteerSlot::new()),
            computer_use_active: false,
            computer_use_injector: crate::injection::ComputerUseInjector::new(),
            preferences_injector: crate::injection::UserPreferencesInjector::new(),
            pending_injector: crate::injection::PendingTasksInjector::new(),
        }
    }

    /// The desktop turns this on when the computer-use capability is serving tools.
    pub fn set_computer_use_active(&mut self, active: bool) {
        self.computer_use_active = active;
    }

    /// Preferences, pending tasks, the todo nudge, and the computer-use contract.
    ///
    /// Called before each model request. A missing memo store or a lookup error
    /// publishes nothing, so memory trouble cannot fail the turn.
    fn apply_desktop_injections(&mut self) {
        if !self.pending_injector.has_published()
            && self.history.len() <= crate::injection::FRESH_SESSION_MAX_HISTORY
        {
            let rendered = self.pending_lines();
            let len = self.history.len();
            if let Some(text) =
                self.pending_injector
                    .collect(crate::injection::AgentKind::Main, len, || rendered)
            {
                self.history.push(variant_injection(text, "pending_tasks"));
            }
        }

        let preferences = self.preference_lines();
        self.preferences_injector.inject(
            crate::injection::AgentKind::Main,
            &mut self.history,
            preferences,
        );

        let todo_active = self.tools.iter().any(|tool| tool.name() == "TodoList");
        let todos = self
            .tools
            .iter()
            .find_map(|tool| tool.todo_items())
            .unwrap_or_default();
        let views = todos
            .into_iter()
            .map(|item| crate::injection::TodoView {
                title: item.title,
                status: item.status,
            })
            .collect::<Vec<_>>();
        if let Some(text) = crate::injection::todo_list_reminder(&self.history, todo_active, &views)
        {
            self.history
                .push(variant_injection(text, "todo_list_reminder"));
        }

        let computer_use_active = self.computer_use_active;
        self.computer_use_injector
            .inject(computer_use_active, &mut self.history);
    }

    fn preference_lines(&self) -> Result<String, ()> {
        let Some(store) = &self.memo_store else {
            return Ok(String::new());
        };
        let memos = store.all().map_err(|_| ())?;
        Ok(crate::injection::render_user_preference_lines(&memos))
    }

    fn pending_lines(&self) -> Result<String, ()> {
        let Some(store) = &self.memo_store else {
            return Ok(String::new());
        };
        let memos = store.all().map_err(|_| ())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        Ok(crate::injection::render_pending_task_lines(
            &memos,
            now,
            crate::injection::PENDING_TASK_INJECTION_LIMIT,
        ))
    }

    /// Slot a concurrent caller can [`SteerSlot::submit`] into while a turn runs.
    pub fn steer_slot(&self) -> Arc<SteerSlot> {
        Arc::clone(&self.steer)
    }

    /// Steer `text` into the active turn, or start a turn when the agent is idle.
    ///
    /// An active turn returns `Ok(None)` and the text shows up on the next
    /// model request. An idle agent runs the text as a normal turn.
    pub async fn steer(
        &mut self,
        text: &str,
        ui: &mut dyn TurnUi,
    ) -> Result<Option<TurnOutcome>, CoreError> {
        if self.steer.submit(text) {
            return Ok(None);
        }
        self.run_turn(text, ui).await.map(Some)
    }

    /// Remove the last `count` real user prompts and the messages that belong
    /// to them.
    ///
    /// Injections are left in place. A compaction summary is a hard stop: it
    /// stays, and nothing before it is removed. `count == 0` and an empty
    /// history do nothing. Fewer prompts than `count` removes what it can.
    pub fn undo(&mut self, count: usize) {
        if count == 0 || self.history.is_empty() {
            return;
        }
        let mut removed_users = 0usize;
        let mut index = self.history.len();
        while index > 0 {
            index -= 1;
            match &self.history[index].origin {
                Some(MessageOrigin::Injection { .. }) => continue,
                Some(MessageOrigin::CompactionSummary) => break,
                _ => {}
            }
            let counts = self.history[index].is_real_user_prompt();
            self.history.remove(index);
            if counts {
                removed_users += 1;
                if removed_users >= count {
                    break;
                }
            }
        }
    }

    /// Conversation history (user / assistant / tool messages).
    pub fn history(&self) -> &[Message] {
        &self.history
    }

    /// Drop all history and session-scoped approvals.
    pub fn clear_history(&mut self) {
        self.history.clear();
        self.approvals.clear();
        self.permission.session_patterns.clear();
        self.last_exit_fingerprint = None;
    }

    /// Apply `default_permission_mode`, `default_file_sandbox`, and `[permission]`
    /// from a config file. CLI flags override the mode after this.
    pub fn apply_permission_config(&mut self, config: &RawConfig) {
        if let Some(mode) = config.default_permission_mode {
            self.permission.mode = mode;
        }
        if let Some(sandbox) = config.default_file_sandbox {
            self.permission.sandbox = sandbox;
        }
        if let Some(permission) = &config.permission {
            self.permission.rules = permission.rules.clone();
        }
    }

    /// `manual`, `yolo`, or `auto`. Yolo does not bypass the file sandbox.
    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.permission.mode = mode;
    }

    pub fn set_file_sandbox(&mut self, sandbox: FileSandboxMode) {
        self.permission.sandbox = sandbox;
    }

    pub fn set_wolfpack_active(&mut self, active: bool) {
        self.permission.wolfpack_active = active;
    }

    fn permission_state(
        &self,
        plan_active: bool,
        plan_file: Option<String>,
        plan_review: Option<String>,
    ) -> PermissionState {
        PermissionState {
            mode: self.permission.mode,
            sandbox: self.permission.sandbox,
            cwd: self.cwd.display().to_string(),
            rules: self.permission.rules.clone(),
            session_patterns: self.permission.session_patterns.clone(),
            plan_active,
            plan_file,
            wolfpack_active: self.permission.wolfpack_active,
            plan_review,
            subagent: self.permission.subagent,
            windows_paths: cfg!(windows),
            inside_git_work_tree: self.cwd.join(".git").exists(),
        }
    }

    /// Override the per-turn model-step limit (tests use small values).
    pub fn set_max_steps(&mut self, max_steps: usize) {
        self.max_steps = max_steps;
    }

    /// Override how many times one model call is tried. Overflow still stops
    /// on the first attempt. Values below 1 are treated as one attempt.
    pub fn set_max_retries(&mut self, max_retries: u32) {
        self.max_retries = max_retries.max(1);
    }

    /// Enable compaction with the model's context window and output budget.
    pub fn set_compaction_limits(&mut self, max_context_tokens: u64, max_output_tokens: u64) {
        self.pipeline = CompactionPipeline::new(max_context_tokens, max_output_tokens);
    }

    /// Attach a persisted session; the history is seeded from it.
    pub fn attach_session(&mut self, session: Session) {
        self.history = session.messages.clone();
        self.session = Some(session);
        // A restored transcript is a new extraction boundary.
        self.last_exit_fingerprint = None;
    }

    /// Share the memo store used by the memory tools. Compaction and session
    /// exit append parsed memos to this same database.
    pub fn attach_memo_store(&mut self, store: Arc<MemoStore>) {
        self.memo_store = Some(store);
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session.as_ref().map(|session| session.id())
    }

    /// Working directory the agent was created for.
    pub fn cwd(&self) -> &std::path::Path {
        &self.cwd
    }

    /// Names of all registered tools (used by the TUI's `/mcp` panel).
    pub fn tool_names(&self) -> Vec<String> {
        self.tools
            .iter()
            .map(|tool| tool.name().to_string())
            .collect()
    }

    /// Session usage snapshot (tokens, steps, tool calls, compactions).
    pub fn usage(&self) -> crate::usage::UsageSnapshot {
        self.usage.snapshot()
    }

    /// Share an externally created plan handle (tools are built before the
    /// agent, so the CLI creates the handle first and attaches it here).
    pub fn attach_plan(&mut self, plan: crate::tools::planning::PlanHandle) {
        self.plan = plan;
    }

    /// The shared plan handle (for building the plan-mode tools).
    pub fn plan_handle(&self) -> crate::tools::planning::PlanHandle {
        std::sync::Arc::clone(&self.plan)
    }

    /// Share an externally created goal handle (persistent store path).
    pub fn attach_goal(&mut self, goal: crate::tools::goal::GoalHandle) {
        self.goal = goal;
    }

    /// The shared goal handle (for building the goal tools).
    pub fn goal_handle(&self) -> crate::tools::goal::GoalHandle {
        std::sync::Arc::clone(&self.goal)
    }

    /// Share an externally created cron store (persistent directory).
    pub fn attach_cron(&mut self, cron: crate::tools::cron::CronHandle) {
        self.cron = cron;
    }

    /// The shared cron handle (for building the cron tools).
    pub fn cron_handle(&self) -> crate::tools::cron::CronHandle {
        std::sync::Arc::clone(&self.cron)
    }

    /// Queue a message to be injected into history before the next turn
    /// (cron fires, notifications).
    pub fn queue_injection(&mut self, message: String) {
        self.injections.push(message);
    }

    /// Share the execution-evidence snapshot used by the goal grader.
    pub fn attach_evidence_snapshot(
        &mut self,
        snapshot: std::sync::Arc<tokio::sync::Mutex<String>>,
    ) {
        self.evidence_snapshot = snapshot;
    }

    /// Base system prompt plus the active plan/goal reminders.
    async fn system_prompt_with_injections(&self) -> String {
        let mut prompt = self.system_prompt.clone();
        {
            let plan = self.plan.lock().await;
            if plan.is_active() {
                let plan_path = plan
                    .plan_path()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                prompt.push_str(&format!(
                    "\n\nPlan mode is active. Write your plan to `{plan_path}`. \
                     Read-only tools are preferred; file writes outside the plan file \
                     are blocked. Do not write code yet — explore, then call \
                     ExitPlanMode when the plan is ready."
                ));
            }
        }
        {
            let goal = self.goal.lock().await;
            if let Some(snapshot) = goal.snapshot()
                && let Some(injection) = crate::goal::goal_injection(&snapshot)
            {
                prompt.push_str("\n\n");
                prompt.push_str(&injection);
            }
        }
        if !self.turn_reminder.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&self.turn_reminder);
        }
        prompt
    }

    /// Remove every tool whose name starts with `prefix` (used when an MCP
    /// server is disabled at runtime).
    pub fn remove_tools_by_prefix(&mut self, prefix: &str) {
        self.tools.retain(|tool| !tool.name().starts_with(prefix));
    }

    /// Append tools (used when an MCP server is re-enabled at runtime).
    pub fn extend_tools(&mut self, tools: Vec<Arc<dyn Tool>>) {
        self.tools.extend(tools);
    }

    /// Wire an external cancellation signal (used by the TUI).
    pub fn set_cancel_signal(&mut self, cancel: Arc<tokio::sync::Notify>) {
        self.cancel = Some(cancel);
    }

    /// Replace the provider (used by model switching).
    pub fn set_provider(&mut self, provider: Arc<dyn ChatProvider>) {
        self.provider = provider;
    }

    /// Persist the current history to the attached session.
    pub fn save_session(&mut self) -> Result<(), CoreError> {
        match &mut self.session {
            Some(session) => session.save(&self.history),
            None => Ok(()),
        }
    }

    /// Directory of the attached session, when one is attached.
    pub fn session_directory(&self) -> Option<&std::path::Path> {
        self.session.as_ref().map(|session| session.directory())
    }

    /// Update the attached session's model and write `state.json`.
    pub fn persist_model(&mut self, model: &str) -> Result<(), CoreError> {
        self.persist_with(|state| state.apply_model(model))
    }

    /// Update the attached session's thinking level and write `state.json`.
    pub fn persist_thinking(&mut self, level: &str) -> Result<(), CoreError> {
        self.persist_with(|state| state.apply_thinking(level))
    }

    /// Update the attached session's permission and write `state.json`.
    pub fn persist_permission(&mut self, mode: &str) -> Result<(), CoreError> {
        self.persist_with(|state| state.apply_permission(mode))
    }

    /// Update the attached session's plan-mode flag and write `state.json`.
    pub fn persist_plan_mode(&mut self, enabled: bool) -> Result<(), CoreError> {
        self.persist_with(|state| {
            state.plan_mode = enabled;
            Ok(())
        })
    }

    fn persist_with(
        &mut self,
        change: impl FnOnce(&mut crate::session::SessionState) -> Result<(), CoreError>,
    ) -> Result<(), CoreError> {
        let history = self.history.clone();
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| CoreError::Session("no session attached".to_string()))?;
        change(&mut session.state)?;
        session.save(&history)
    }

    pub fn provider_name(&self) -> &str {
        self.provider.name()
    }

    pub fn model_name(&self) -> &str {
        self.provider.model_name()
    }

    /// Run one user turn to completion, persisting the session afterwards.
    ///
    /// On interruption or stream failure the history is rolled back to its
    /// state before the turn, so a retry starts clean.
    pub async fn run_turn(
        &mut self,
        input: &str,
        ui: &mut dyn TurnUi,
    ) -> Result<TurnOutcome, CoreError> {
        self.run_turn_with_images(input, &[], ui).await
    }

    /// Like [`Agent::run_turn`], but attaches image URLs (local paths or
    /// data URLs) to the user message.
    pub async fn run_turn_with_images(
        &mut self,
        input: &str,
        images: &[String],
        ui: &mut dyn TurnUi,
    ) -> Result<TurnOutcome, CoreError> {
        let started = std::time::Instant::now();
        let tokens_before = self.usage_totals();
        // Turn-scoped session-memory reminder (consumed by the system prompt).
        self.turn_reminder = self.session_memory.summary();
        let outcome = self.run_turn_inner(input, images, ui).await;
        // Goal-mode accounting: tokens and wall clock for this turn.
        {
            let tokens = self.usage_totals().saturating_sub(tokens_before);
            let mut goal = self.goal.lock().await;
            goal.record_turn(tokens, started.elapsed().as_millis() as u64);
        }
        // Refresh the shared execution-evidence snapshot for the grader.
        {
            let evidence = crate::grader::recent_evidence(self.history(), 8000);
            *self.evidence_snapshot.lock().await = evidence;
        }
        self.turn_reminder.clear();
        // Persist whatever the turn left behind (rollbacks included).
        if self.session.is_some()
            && let Err(error) = self.save_session()
        {
            ui.notice(&format!("failed to save session: {error}")).await;
        }
        outcome
    }

    /// Total input+output tokens recorded so far (goal accounting).
    fn usage_totals(&self) -> u64 {
        let snapshot = self.usage.snapshot();
        snapshot.total.input_tokens + snapshot.total.output_tokens
    }

    async fn run_turn_inner(
        &mut self,
        input: &str,
        images: &[String],
        ui: &mut dyn TurnUi,
    ) -> Result<TurnOutcome, CoreError> {
        let checkpoint = self.history.len();
        self.steer.activate();
        let _active = TurnActiveGuard(Arc::clone(&self.steer));
        // Flush queued injections (cron fires) before the user input.
        let injections = std::mem::take(&mut self.injections);
        for injection in injections {
            self.history.push(injection_message(injection));
        }
        self.history.push(user_prompt_with_images(input, images));

        let mut steps = 0usize;
        loop {
            // A steer that arrived during the previous step joins the history
            // before the next model call.
            self.flush_steers();
            self.apply_desktop_injections();
            if steps >= self.max_steps {
                return Ok(TurnOutcome {
                    steps,
                    interrupted: false,
                    hit_step_limit: true,
                });
            }
            steps += 1;

            let tool_definitions: Vec<ToolDefinition> = self
                .tools
                .iter()
                .map(|tool| ToolDefinition {
                    name: tool.name().to_string(),
                    description: tool.description().to_string(),
                    parameters: tool.parameters_schema(),
                })
                .collect();

            // Shape the outgoing history (micro projection + full compaction).
            let projected = self.prepare_history(ui).await?;

            let stream = match self
                .generate_with_retry(
                    &self.system_prompt_with_injections().await,
                    &tool_definitions,
                    &projected,
                )
                .await
            {
                Ok(stream) => stream,
                Err(error) if is_context_overflow(&error) => {
                    // One attempt was enough. Compact and continue, or surface
                    // the overflow when there is nothing safe to summarize.
                    match self.run_full_compaction().await {
                        Ok(true) => {
                            self.usage.record_compaction();
                            ui.notice("compacted conversation after context overflow")
                                .await;
                            continue;
                        }
                        Ok(false) => {
                            self.steer.clear();
                            self.history.truncate(checkpoint);
                            return Err(error.into());
                        }
                        Err(compact_error) => {
                            self.steer.clear();
                            self.history.truncate(checkpoint);
                            return Err(compact_error);
                        }
                    }
                }
                Err(error) => {
                    self.session_memory.record_error(&error.to_string());
                    self.steer.clear();
                    self.history.truncate(checkpoint);
                    return Err(error.into());
                }
            };

            let summary_handle = stream.summary();
            let mut parts = Vec::new();
            let mut parts_stream = stream.into_parts();
            let mut interrupted = false;
            loop {
                tokio::select! {
                    item = parts_stream.next() => match item {
                        None => break,
                        Some(Ok(part)) => {
                            match &part {
                                StreamedMessagePart::Content(ContentPart::Text { text }) => {
                                    ui.text_delta(text).await;
                                }
                                StreamedMessagePart::Content(ContentPart::Think { think, .. }) => {
                                    ui.think_delta(think).await;
                                }
                                _ => {}
                            }
                            parts.push(part);
                        }
                        Some(Err(error)) => {
                            self.history.truncate(checkpoint);
                            return Err(error.into());
                        }
                    },
                    () = wait_for_ctrl_c() => {
                        interrupted = true;
                        break;
                    }
                    () = self.wait_cancel() => {
                        interrupted = true;
                        break;
                    }
                }
            }

            if interrupted {
                self.steer.clear();
                self.history.truncate(checkpoint);
                return Ok(TurnOutcome {
                    steps: steps - 1,
                    interrupted: true,
                    hit_step_limit: false,
                });
            }

            self.usage.record_llm_step();
            if let Some(usage) = summary_handle.lock().expect("summary lock").usage {
                let model_name = self.provider.model_name().to_string();
                self.usage.record(&model_name, usage);
            }

            let (content, tool_calls) = assemble_parts(parts);
            self.history
                .push(Message::assistant(content, tool_calls.clone()));

            if tool_calls.is_empty() {
                // A steer that landed while this reply was streaming keeps
                // the turn going so the model sees it.
                if self.flush_steers() {
                    continue;
                }
                return Ok(TurnOutcome {
                    steps,
                    interrupted: false,
                    hit_step_limit: false,
                });
            }

            for call in &tool_calls {
                let arguments = call.arguments.clone().unwrap_or_else(|| "{}".to_string());
                self.usage.record_tool_call(&call.name);
                ui.tool_start(&call.name, &arguments).await;
                match self.execute_tool(call, &arguments, ui).await {
                    ToolExec::Interrupted => {
                        ui.tool_end(&call.name, false, "interrupted").await;
                        self.steer.clear();
                        self.history.truncate(checkpoint);
                        return Ok(TurnOutcome {
                            steps,
                            interrupted: true,
                            hit_step_limit: false,
                        });
                    }
                    ToolExec::Finished(result) => {
                        ui.tool_end(&call.name, result.ok, &truncate_for_ui(&result.text))
                            .await;
                        // Session running notes (post-compaction context retention).
                        let args_summary: String = arguments.chars().take(80).collect();
                        self.session_memory.record_tool_execution(
                            &call.name,
                            &args_summary,
                            !result.ok,
                        );
                        self.history
                            .push(Message::tool_result_parts(call.id.clone(), result.content));
                        // Keep the grader's evidence snapshot current mid-turn: the
                        // model may call UpdateGoal(complete) before the turn ends.
                        let evidence = crate::grader::recent_evidence(&self.history, 8000);
                        *self.evidence_snapshot.lock().await = evidence;
                    }
                }
            }
        }
    }

    /// Resolves when an external cancel signal fires (never, when unset).
    async fn wait_cancel(&self) {
        match &self.cancel {
            Some(cancel) => cancel.notified().await,
            None => std::future::pending().await,
        }
    }

    /// Apply compaction and return the message list to send to the model.
    async fn prepare_history(&mut self, ui: &mut dyn TurnUi) -> Result<Vec<Message>, CoreError> {
        if self.pipeline.max_context_tokens() == 0 {
            return Ok(self.history.clone());
        }
        let tool_tokens: u64 = self
            .tools
            .iter()
            .map(|tool| estimate_tokens(tool.name()) + estimate_tokens(tool.description()))
            .sum();
        let base = estimate_tokens(&self.system_prompt) + tool_tokens;
        let used = base + estimate_tokens_for_messages(&self.history);

        if !self.pipeline.should_compact(used) {
            return Ok(self.pipeline.apply_micro(&self.history));
        }

        // Micro first (free), then full summarization when still over.
        let projected = self.pipeline.apply_micro(&self.history);
        let used_after_micro = base + estimate_tokens_for_messages(&projected);
        if !self.pipeline.should_compact(used_after_micro) {
            self.usage.record_compaction();
            ui.notice(&format!(
                "micro-compaction applied: {used} → {used_after_micro} estimated tokens"
            ))
            .await;
            return Ok(projected);
        }

        if self.pipeline.breaker_open() {
            ui.notice("compaction disabled for this turn after repeated failures")
                .await;
            return Ok(projected);
        }

        match self.run_full_compaction().await {
            Ok(true) => {
                self.pipeline.record_success();
                self.usage.record_compaction();
                let after = base + estimate_tokens_for_messages(&self.history);
                if let Some(warning) = self.compaction_memo_warning.take() {
                    ui.notice(&warning).await;
                }
                ui.notice(&format!(
                    "compacted conversation: {used} → {after} estimated tokens"
                ))
                .await;
                Ok(self.pipeline.apply_micro(&self.history))
            }
            Ok(false) => Ok(projected),
            Err(error) => {
                self.pipeline.record_failure();
                if self.pipeline.should_block(used) {
                    // Blocking threshold: the turn cannot continue safely.
                    return Err(error);
                }
                ui.notice(&format!("compaction failed (continuing): {error}"))
                    .await;
                Ok(projected)
            }
        }
    }

    /// Summarize the old prefix of the history with the model.
    /// Returns `true` when the history was replaced.
    async fn run_full_compaction(&mut self) -> Result<bool, CoreError> {
        let Some(split) = self.pipeline.plan_full_split(&self.history) else {
            return Ok(false);
        };
        if split == 0 {
            return Ok(false);
        }
        let to_summarize: Vec<Message> = self.history[..split].to_vec();
        let rendered = render_messages(&to_summarize);
        let instruction = include_str!("compaction.md");
        let prompt = format!("{instruction}\n\n<conversation>\n{rendered}\n</conversation>");

        let summary = self.collect_completion(&prompt).await?;
        self.commit_compaction(split, &summary);
        Ok(true)
    }

    /// Replace the leading `split` messages with one compaction summary.
    fn commit_compaction(&mut self, split: usize, summary: &str) {
        let mut new_history = Vec::with_capacity(self.history.len() - split + 1);
        new_history.push(
            Message::user(format!(
                "[Context compaction] The earlier conversation was summarized:\n\n{summary}"
            ))
            .with_origin(MessageOrigin::CompactionSummary),
        );
        new_history.extend_from_slice(&self.history[split..]);
        self.history = new_history;
        self.preferences_injector.on_context_compacted(split);
        self.computer_use_injector.on_context_compacted();
        self.pipeline.reset_micro();
        // Memo extraction must not sink a summary that is already committed.
        self.compaction_memo_warning = self.store_compaction_memos(summary);
    }

    /// Summarize the longest safe prefix and persist the shorter history.
    ///
    /// The conversation is given to the model as the system prompt. The user
    /// turn stays a short instruction so the stored summary does not echo the
    /// whole transcript back into the history.
    pub async fn compact_now(
        &mut self,
        instruction: Option<&str>,
    ) -> Result<CompactionOutcome, CoreError> {
        let Some(split) = CompactionPipeline::plan_manual_split(&self.history) else {
            return Err(CoreError::Compaction(
                "No prefix that can be compacted in current history.".to_string(),
            ));
        };
        let tokens_before = estimate_tokens_for_messages(&self.history);
        let rendered = render_messages(&self.history[..split]);
        let mut system = include_str!("compaction.md").to_string();
        if let Some(instruction) = instruction.map(str::trim).filter(|text| !text.is_empty()) {
            system.push_str("\n\nAdditional instruction:\n");
            system.push_str(instruction);
        }
        system.push_str("\n\n<conversation>\n");
        system.push_str(&rendered);
        system.push_str("\n</conversation>");
        let summary = self
            .collect_text(&system, "Summarize the earlier conversation.")
            .await?;
        if summary.trim().is_empty() {
            return Err(CoreError::Compaction(
                "summarizer returned no text".to_string(),
            ));
        }
        self.commit_compaction(split, &summary);
        self.usage.record_compaction();
        let tokens_after = estimate_tokens_for_messages(&self.history);
        self.save_session()?;
        Ok(CompactionOutcome {
            summary,
            compacted_count: split,
            tokens_before,
            tokens_after,
        })
    }

    /// Parse `memory-memo` fences from a compaction summary and append them.
    ///
    /// `extraction_source` stays `compaction` (the parser's value). Session id,
    /// title, and project directory are filled here. Append errors become a
    /// notice; they do not fail the compaction.
    fn store_compaction_memos(&self, summary: &str) -> Option<String> {
        let Some(store) = &self.memo_store else {
            return None;
        };
        let mut memos = parse_memory_memos(summary);
        if memos.is_empty() {
            return None;
        }
        let session_id = self
            .session
            .as_ref()
            .map(|session| session.id().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let title = self
            .session
            .as_ref()
            .and_then(|session| session.state.title.clone())
            .unwrap_or_default();
        let project_dir = project_dir_key(&self.cwd);
        let total = memos.len();
        let mut failed = 0usize;
        for memo in &mut memos {
            memo.source_session_id.clone_from(&session_id);
            memo.source_session_title = Some(title.clone());
            memo.project_dir.clone_from(&project_dir);
            if store.append(memo).is_err() {
                failed += 1;
            }
        }
        if failed > 0 {
            Some(format!(
                "failed to store {failed} of {total} memory memo(s) from compaction"
            ))
        } else {
            None
        }
    }

    /// One-shot completion collected into text (used by compaction).
    /// Empty model text is a compaction failure.
    async fn collect_completion(&self, prompt: &str) -> Result<String, CoreError> {
        let text = self.collect_text("", prompt).await?;
        if text.trim().is_empty() {
            return Err(CoreError::Compaction("summarizer returned no text".into()));
        }
        Ok(text)
    }

    /// One-shot completion with an explicit system prompt and no tools.
    /// Empty text is returned as an empty string.
    async fn collect_text(&self, system: &str, prompt: &str) -> Result<String, CoreError> {
        let stream = self
            .generate_with_retry(system, &[], &[Message::user(prompt)])
            .await?;
        let mut parts = Vec::new();
        let mut parts_stream = stream.into_parts();
        while let Some(item) = parts_stream.next().await {
            parts.push(item?);
        }
        let (content, _) = assemble_parts(parts);
        let text = content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        Ok(text)
    }

    /// Extract task memos from the conversation when a session ends.
    ///
    /// Mirrors `extractMemoriesOnExit`: skip histories shorter than four
    /// messages, skip an unchanged snapshot, sample the last ten messages plus
    /// pitfall windows, and ask the attached provider with no tools. There is
    /// no `utility_model` in the Rust config yet, so this uses the session
    /// provider. Failures do not advance the fingerprint. An empty parse still
    /// does. This path does not record usage and does not call the goal grader.
    pub async fn extract_memories_on_exit(&mut self) {
        let Some(store) = self.memo_store.clone() else {
            return;
        };
        let history = self.history.clone();
        if history.len() < 4 {
            return;
        }
        let fingerprint = history_fingerprint(&history);
        if self.last_exit_fingerprint == Some(fingerprint) {
            return;
        }

        let session_id = self
            .session
            .as_ref()
            .map(|session| session.id().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let title = self
            .session
            .as_ref()
            .and_then(|session| session.state.title.clone())
            .unwrap_or_default();
        let project_dir = project_dir_key(&self.cwd);
        let pending = load_pending_refs(&store);
        let sample = render_exit_sample(&history);
        let prompt =
            build_exit_extraction_prompt(&session_id, history.len(), &sample, Some(&pending));

        let summary = match self
            .collect_text(EXIT_EXTRACTION_SYSTEM_PROMPT, &prompt)
            .await
        {
            Ok(summary) => summary,
            Err(_) => return,
        };

        let mut memos = parse_memory_memos(&summary);
        let resolved_ids = parse_resolved_pending_ids(&summary);
        if memos.is_empty() && resolved_ids.is_empty() {
            self.last_exit_fingerprint = Some(fingerprint);
            return;
        }

        for memo in &mut memos {
            memo.source_session_id.clone_from(&session_id);
            memo.source_session_title = Some(title.clone());
            memo.extraction_source = "exit".to_string();
            memo.project_dir.clone_from(&project_dir);
            let _ = store.append(memo);
        }
        let offered: std::collections::HashSet<&str> =
            pending.iter().map(|task| task.id.as_str()).collect();
        for id in &resolved_ids {
            if !offered.contains(id.as_str()) {
                continue;
            }
            let still_pending = store
                .find_by_id(id)
                .ok()
                .flatten()
                .is_some_and(|memo| memo.kind == MemoKind::Pending);
            if still_pending {
                let _ = store.delete(id);
            }
        }
        self.last_exit_fingerprint = Some(fingerprint);
    }

    /// One model call, retried when the error is transient.
    ///
    /// Context overflow returns on the first attempt so the turn can compact
    /// instead of sending the same overflowing request again.
    async fn generate_with_retry(
        &self,
        system_prompt: &str,
        tools: &[ToolDefinition],
        history: &[Message],
    ) -> Result<StreamedMessage, LlmError> {
        let max_attempts = self.max_retries;
        let provider = Arc::clone(&self.provider);
        let system_prompt = system_prompt.to_string();
        let tools = tools.to_vec();
        let history = history.to_vec();
        chat_with_retry(
            max_attempts,
            true,
            is_retryable_llm_error,
            move |_attempt| {
                let provider = Arc::clone(&provider);
                let system_prompt = system_prompt.clone();
                let tools = tools.clone();
                let history = history.clone();
                async move {
                    provider
                        .generate(&system_prompt, &tools, &history, GenerateOptions::default())
                        .await
                }
            },
            |delay_ms| async move {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            },
        )
        .await
    }

    /// Append steered user prompts. Returns true when at least one was added.
    fn flush_steers(&mut self) -> bool {
        let pending = self.steer.take();
        if pending.is_empty() {
            return false;
        }
        self.history.extend(pending);
        true
    }

    async fn execute_tool(
        &mut self,
        call: &ToolCall,
        arguments: &str,
        ui: &mut dyn TurnUi,
    ) -> ToolExec {
        let Some(tool) = self
            .tools
            .iter()
            .find(|tool| tool.name() == call.name)
            .cloned()
        else {
            return ToolExec::Finished(ToolResult::failure(format!(
                "error: unknown tool `{}`",
                call.name
            )));
        };
        let parsed: serde_json::Value = match serde_json::from_str(arguments) {
            Ok(value) => value,
            Err(error) => {
                return ToolExec::Finished(ToolResult::failure(format!(
                    "error: invalid tool arguments JSON: {error}"
                )));
            }
        };
        let (plan_active, plan_file) = {
            let plan = self.plan.lock().await;
            (
                plan.is_active(),
                plan.plan_path().map(|path| path.display().to_string()),
            )
        };
        let accesses = tool.declared_file_accesses(&parsed);
        let session_approved = self.approvals.is_approved(&call.name, arguments);
        let plan_review = if call.name == "ExitPlanMode" {
            plan_file
                .as_deref()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .filter(|text| !text.trim().is_empty())
        } else {
            None
        };
        let decision = decide(
            &PermissionRequest {
                tool_name: call.name.as_str(),
                accesses: &accesses,
                unrestricted: tool.unrestricted(),
                declares_no_approval: !tool.requires_approval(),
                session_approved,
                matches_rule: None,
            },
            &self.permission_state(plan_active, plan_file, plan_review),
        );
        match decision.kind {
            crate::permission_chain::PermissionOutcome::Deny => {
                let message = decision.message.unwrap_or_else(|| {
                    format!("Tool \"{}\" was denied by permission rule.", call.name)
                });
                return ToolExec::Finished(ToolResult::failure(format!("error: {message}")));
            }
            crate::permission_chain::PermissionOutcome::Ask => {
                if !session_approved && !ui.approve(&call.name, arguments).await {
                    return ToolExec::Finished(ToolResult::failure("error: denied by user"));
                }
                self.approvals.record(&call.name, arguments);
            }
            crate::permission_chain::PermissionOutcome::Approve => {}
        }
        // Questions are asked after the chain so auto mode can deny them,
        // and before execution because a question is not a file write.
        if call.name == "AskUserQuestion" {
            return self.ask_user_question(&parsed, ui).await;
        }
        match tool.execute_rich(&parsed, &self.cwd).await {
            Ok(result) => ToolExec::Finished(result),
            Err(error) => ToolExec::Finished(ToolResult::failure(format!("error: {error}"))),
        }
    }

    /// Validate, ask the UI, and shape the tool result.
    /// Cancel and Ctrl+C abort the turn instead of feeding the model an error.
    async fn ask_user_question(
        &mut self,
        arguments: &serde_json::Value,
        ui: &mut dyn TurnUi,
    ) -> ToolExec {
        let questions = match crate::tools::ask_user::parse_questions(arguments) {
            Ok(questions) => questions,
            Err(error) => {
                return ToolExec::Finished(ToolResult::failure(format!("error: {error}")));
            }
        };
        let answer = tokio::select! {
            biased;
            () = self.wait_cancel() => return ToolExec::Interrupted,
            () = wait_for_ctrl_c() => return ToolExec::Interrupted,
            answer = ui.ask_user(&questions) => answer,
        };
        let (output, ok) = crate::tools::ask_user::format_ask_user_result(answer);
        if ok {
            ToolExec::Finished(ToolResult::success(output))
        } else {
            ToolExec::Finished(ToolResult::failure(format!("error: {output}")))
        }
    }
}

fn project_dir_key(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// How many pending memos the exit prompt may offer for closure.
const PENDING_TASK_SCAN_LIMIT: usize = 12;

fn load_pending_refs(store: &MemoStore) -> Vec<PendingTaskRef> {
    let Ok(memos) = store.all() else {
        return Vec::new();
    };
    memos
        .into_iter()
        .filter(|memo| memo.kind == MemoKind::Pending && !memo.id.is_empty())
        .take(PENDING_TASK_SCAN_LIMIT)
        .map(|memo| PendingTaskRef {
            id: memo.id,
            user_need: memo.user_need.trim().to_string(),
        })
        .collect()
}

fn history_fingerprint(history: &[Message]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for message in history {
        role_name(message.role).hash(&mut hasher);
        message.text().hash(&mut hasher);
        message.tool_call_id.hash(&mut hasher);
        for call in &message.tool_calls {
            call.id.hash(&mut hasher);
            call.name.hash(&mut hasher);
            call.arguments.hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

/// Text parts joined with a space. `Message::text` concatenates with no
/// separator; the exit sampler matches the TypeScript `join(' ')`.
fn message_sample_text(message: &Message) -> String {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Last 10 messages, plus up to 20 newest pitfall-window messages from the
/// older prefix. A pitfall is a tool message whose text starts with `error:`.
fn render_exit_sample(history: &[Message]) -> String {
    const RECENT_COUNT: usize = 10;
    const MAX_PITFALL_MESSAGES: usize = 20;
    let start = history.len().saturating_sub(RECENT_COUNT);
    let mut pitfalls = Vec::new();
    for index in 0..start {
        let Some(message) = history.get(index) else {
            continue;
        };
        if message.role != Role::Tool || !message_sample_text(message).starts_with("error:") {
            continue;
        }
        let from = index.saturating_sub(2);
        let to = (index + 2).min(start.saturating_sub(1));
        for neighbor in from..=to {
            if !pitfalls.contains(&neighbor) {
                pitfalls.push(neighbor);
            }
        }
    }
    pitfalls.sort_unstable();
    let keep_from = pitfalls.len().saturating_sub(MAX_PITFALL_MESSAGES);
    let mut indices = pitfalls[keep_from..].to_vec();
    indices.extend(start..history.len());
    indices.sort_unstable();
    indices.dedup();
    indices
        .into_iter()
        .map(|index| {
            let message = &history[index];
            let clipped: String = message_sample_text(message).chars().take(300).collect();
            format!("[{}] {clipped}", role_name(message.role))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::Path;
    use std::sync::Mutex;

    use lmcode_llm::LlmError;
    use lmcode_llm::message::Role;
    use lmcode_llm::provider::{BoxStream, FinishReason, StreamSummary, StreamedMessage};

    /// Provider that replays a fixed script of streamed parts, one script
    /// entry per `generate` call.
    struct MockProvider {
        turns: Mutex<VecDeque<Vec<StreamedMessagePart>>>,
        seen: Mutex<Vec<Vec<Message>>>,
    }

    #[async_trait]
    impl ChatProvider for MockProvider {
        fn name(&self) -> &str {
            "mock"
        }
        fn model_name(&self) -> &str {
            "mock-model"
        }
        async fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[ToolDefinition],
            history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            self.seen.lock().unwrap().push(history.to_vec());
            let parts = self.turns.lock().unwrap().pop_front().unwrap_or_default();
            let stream: BoxStream<Result<StreamedMessagePart, LlmError>> =
                Box::pin(futures_util::stream::iter(parts.into_iter().map(Ok)));
            let summary = StreamSummary {
                finish_reason: Some(FinishReason::Completed),
                ..StreamSummary::default()
            };
            Ok(StreamedMessage::new(stream, Arc::new(Mutex::new(summary))))
        }
    }

    struct EchoTool {
        requires_approval: bool,
    }

    #[async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &str {
            "Echo"
        }
        fn description(&self) -> &str {
            "Echo the `value` argument back"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            serde_json::json!({
                "type": "object",
                "properties": { "value": { "type": "string" } },
                "required": ["value"]
            })
        }
        fn requires_approval(&self) -> bool {
            self.requires_approval
        }
        async fn execute(
            &self,
            arguments: &serde_json::Value,
            _cwd: &Path,
        ) -> Result<String, String> {
            Ok(format!(
                "echo: {}",
                arguments["value"].as_str().unwrap_or("")
            ))
        }
    }

    #[derive(Default)]
    struct MockUi {
        text: String,
        think: String,
        tool_starts: Vec<String>,
        approve_result: bool,
        approvals_requested: usize,
        notices: Vec<String>,
    }

    #[async_trait]
    impl TurnUi for MockUi {
        async fn text_delta(&mut self, text: &str) {
            self.text.push_str(text);
        }
        async fn think_delta(&mut self, text: &str) {
            self.think.push_str(text);
        }
        async fn tool_start(&mut self, name: &str, _arguments: &str) {
            self.tool_starts.push(name.to_string());
        }
        async fn tool_end(&mut self, _name: &str, _ok: bool, _result: &str) {}
        async fn approve(&mut self, _name: &str, _arguments: &str) -> bool {
            self.approvals_requested += 1;
            self.approve_result
        }
        async fn notice(&mut self, message: &str) {
            self.notices.push(message.to_string());
        }
    }

    fn tool_call_part(id: &str, name: &str, arguments: &str) -> StreamedMessagePart {
        StreamedMessagePart::ToolCall(ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: Some(arguments.to_string()),
            stream_index: Some(0),
        })
    }

    fn text_part(text: &str) -> StreamedMessagePart {
        StreamedMessagePart::Content(ContentPart::Text {
            text: text.to_string(),
        })
    }

    fn agent_with(turns: Vec<Vec<StreamedMessagePart>>, tool: EchoTool, max_steps: usize) -> Agent {
        let provider = Arc::new(MockProvider {
            turns: Mutex::new(VecDeque::from(turns)),
            seen: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(
            provider,
            vec![Arc::new(tool)],
            "system prompt",
            PathBuf::from("."),
        );
        agent.set_max_steps(max_steps);
        agent
    }

    #[tokio::test]
    async fn runs_tool_call_loop_and_appends_history() {
        let mut agent = agent_with(
            vec![
                vec![
                    text_part("let me "),
                    tool_call_part("call_1", "Echo", r#"{"value":"hi"}"#),
                ],
                vec![text_part("done")],
            ],
            EchoTool {
                requires_approval: false,
            },
            10,
        );
        let mut ui = MockUi::default();

        let outcome = agent.run_turn("say hi", &mut ui).await.unwrap();

        assert_eq!(outcome.steps, 2);
        assert!(!outcome.interrupted);
        assert!(!outcome.hit_step_limit);
        assert_eq!(ui.text, "let me done");
        assert_eq!(ui.tool_starts, vec!["Echo"]);
        assert_eq!(ui.approvals_requested, 0, "auto-approved tool must not ask");

        let history = agent.history();
        assert_eq!(history.len(), 4);
        assert_eq!(history[0].role, Role::User);
        assert_eq!(history[1].role, Role::Assistant);
        assert_eq!(history[1].tool_calls.len(), 1);
        assert_eq!(history[1].tool_calls[0].stream_index, None);
        assert_eq!(history[2].role, Role::Tool);
        assert_eq!(history[2].text(), "echo: hi");
        assert_eq!(history[3].role, Role::Assistant);
        assert_eq!(history[3].text(), "done");
    }

    #[tokio::test]
    async fn denied_tool_call_reports_denial_to_the_model() {
        let mut agent = agent_with(
            vec![
                vec![tool_call_part("call_1", "Echo", r#"{"value":"x"}"#)],
                vec![text_part("understood")],
            ],
            EchoTool {
                requires_approval: true,
            },
            10,
        );
        let mut ui = MockUi {
            approve_result: false,
            ..MockUi::default()
        };

        let outcome = agent.run_turn("do it", &mut ui).await.unwrap();

        assert_eq!(outcome.steps, 2);
        assert_eq!(ui.approvals_requested, 1);
        assert!(agent.history()[2].text().contains("denied"));
    }

    #[tokio::test]
    async fn workspace_write_sandbox_denies_before_the_tool_runs() {
        struct OutsideWrite {
            ran: Arc<std::sync::atomic::AtomicBool>,
        }

        #[async_trait]
        impl Tool for OutsideWrite {
            fn name(&self) -> &str {
                "Write"
            }
            fn description(&self) -> &str {
                "probe"
            }
            fn parameters_schema(&self) -> serde_json::Value {
                serde_json::json!({"type": "object"})
            }
            fn declared_file_accesses(
                &self,
                _arguments: &serde_json::Value,
            ) -> Vec<crate::permission::FileAccess> {
                vec![crate::permission::FileAccess::new(
                    "/tmp/outside.ts",
                    crate::permission::FileOperation::Write,
                )]
            }
            async fn execute(
                &self,
                _arguments: &serde_json::Value,
                _cwd: &Path,
            ) -> Result<String, String> {
                self.ran.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok("wrote".to_string())
            }
        }

        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let provider = Arc::new(MockProvider {
            turns: Mutex::new(VecDeque::from(vec![
                vec![tool_call_part("call_1", "Write", "{}")],
                vec![text_part("stopped")],
            ])),
            seen: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(
            provider,
            vec![Arc::new(OutsideWrite {
                ran: Arc::clone(&ran),
            })],
            "system",
            PathBuf::from("/workspace"),
        );
        agent.set_permission_mode(crate::config::PermissionMode::Yolo);
        agent.set_file_sandbox(crate::config::FileSandboxMode::WorkspaceWrite);
        let mut ui = MockUi {
            approve_result: true,
            ..MockUi::default()
        };

        agent.run_turn("write outside", &mut ui).await.unwrap();

        assert!(!ran.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(ui.approvals_requested, 0);
        assert!(agent.history()[2].text().contains(
            "File writes outside the workspace are disabled by the workspace-write file sandbox."
        ));
    }

    #[tokio::test]
    async fn stops_at_step_limit_without_losing_history() {
        let mut agent = agent_with(
            vec![
                vec![tool_call_part("call_1", "Echo", r#"{"value":"a"}"#)],
                vec![tool_call_part("call_2", "Echo", r#"{"value":"b"}"#)],
            ],
            EchoTool {
                requires_approval: false,
            },
            1,
        );
        let mut ui = MockUi::default();

        let outcome = agent.run_turn("loop", &mut ui).await.unwrap();

        assert!(outcome.hit_step_limit);
        assert_eq!(outcome.steps, 1);
        // user + assistant(tool call) + tool result
        assert_eq!(agent.history().len(), 3);
    }

    #[tokio::test]
    async fn unknown_tool_returns_error_to_the_model() {
        let mut agent = agent_with(
            vec![
                vec![tool_call_part("call_1", "Nope", "{}")],
                vec![text_part("ok")],
            ],
            EchoTool {
                requires_approval: false,
            },
            10,
        );
        let mut ui = MockUi::default();

        agent.run_turn("use nope", &mut ui).await.unwrap();

        assert!(agent.history()[2].text().contains("unknown tool"));
    }

    #[tokio::test]
    async fn micro_projection_reaches_the_model_without_mutating_history() {
        let provider = Arc::new(MockProvider {
            turns: Mutex::new(VecDeque::from(vec![vec![text_part("ok")]])),
            seen: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(
            provider.clone(),
            vec![Arc::new(EchoTool {
                requires_approval: false,
            })],
            "system prompt",
            PathBuf::from("."),
        );
        agent.set_compaction_limits(1_000, 100);
        let long_result = "z".repeat(2_000);
        let mut history = Vec::new();
        for index in 0..24 {
            history.push(Message::user(format!("m{index}")));
        }
        history.insert(1, Message::tool_result("call_long", &long_result));
        agent.history = history;

        let mut ui = MockUi::default();
        agent.run_turn("go", &mut ui).await.unwrap();

        // The model saw the truncated projection…
        let seen = provider.seen.lock().unwrap();
        let sent = seen.last().unwrap();
        assert!(
            sent.iter()
                .any(|m| m.text() == crate::compaction::MICRO_MARKER),
            "projection should carry the micro marker"
        );
        // …while the stored history stays intact.
        assert!(
            agent.history().iter().any(|m| m.text() == long_result),
            "stored history must keep the original tool result"
        );
    }

    #[tokio::test]
    async fn full_compaction_summarizes_and_replaces_history() {
        let mut agent = agent_with(
            vec![
                vec![text_part("SUMMARY-TEXT")],
                vec![text_part("final answer")],
            ],
            EchoTool {
                requires_approval: false,
            },
            10,
        );
        agent.set_compaction_limits(2_000, 100);
        // Well over 75% of the 2000-token window.
        agent.history = vec![
            Message::user("x".repeat(3_000)),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "y".repeat(3_000),
                }],
                vec![],
            ),
            Message::user("recent question"),
        ];

        let mut ui = MockUi::default();
        let outcome = agent.run_turn("go", &mut ui).await.unwrap();

        assert_eq!(outcome.steps, 1);
        let history = agent.history();
        assert!(
            history[0].text().contains("SUMMARY-TEXT"),
            "first message should be the summary, got: {:?}",
            history[0].text()
        );
        assert!(
            history.iter().any(|m| m.text() == "go"),
            "the current user message must survive"
        );
        assert!(
            ui.notices
                .iter()
                .any(|n| n.contains("compacted conversation")),
            "notices: {:?}",
            ui.notices
        );
    }

    fn memo_summary(user_need: &str) -> String {
        format!(
            "SUMMARY-TEXT\n```memory-memo\n{{\"userNeed\":\"{user_need}\",\"approach\":\"解析围栏\",\"outcome\":\"完成\",\"whatFailed\":\"none\",\"whatWorked\":\"接到压缩\"}}\n```\n"
        )
    }

    #[tokio::test]
    async fn compaction_stores_memos_with_session_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap());
        let sessions = crate::session::SessionStore::with_root(dir.path().join("sessions"));
        let mut session = sessions.create(Path::new("E:/work"), "mock").unwrap();
        session.state.title = Some("压缩试验".to_string());
        let session_id = session.id().to_string();

        let mut agent = agent_with(
            vec![
                vec![text_part(&memo_summary("记住压缩"))],
                vec![text_part("final answer")],
            ],
            EchoTool {
                requires_approval: false,
            },
            10,
        );
        agent.attach_memo_store(Arc::clone(&store));
        agent.attach_session(session);
        agent.set_compaction_limits(2_000, 100);
        agent.history = vec![
            Message::user("x".repeat(3_000)),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "y".repeat(3_000),
                }],
                vec![],
            ),
            Message::user("recent question"),
        ];

        let mut ui = MockUi::default();
        agent.run_turn("go", &mut ui).await.unwrap();

        assert!(agent.history()[0].text().contains("SUMMARY-TEXT"));
        let memos = store.all().unwrap();
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "记住压缩");
        assert_eq!(memos[0].extraction_source, "compaction");
        assert_eq!(memos[0].source_session_id, session_id);
        assert_eq!(memos[0].source_session_title.as_deref(), Some("压缩试验"));
        assert_eq!(memos[0].project_dir, ".");
        assert!(
            ui.notices
                .iter()
                .any(|notice| notice.contains("compacted conversation"))
        );
        assert!(
            ui.notices
                .iter()
                .all(|notice| !notice.contains("failed to store"))
        );
    }

    #[tokio::test]
    async fn compaction_keeps_the_summary_when_memo_appends_fail() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap());
        store.refuse_writes().unwrap();
        let mut agent = agent_with(
            vec![
                vec![text_part(&memo_summary("写不进去"))],
                vec![text_part("final answer")],
            ],
            EchoTool {
                requires_approval: false,
            },
            10,
        );
        agent.attach_memo_store(store.clone());
        agent.set_compaction_limits(2_000, 100);
        agent.history = vec![
            Message::user("x".repeat(3_000)),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "y".repeat(3_000),
                }],
                vec![],
            ),
            Message::user("recent question"),
        ];

        let mut ui = MockUi::default();
        agent.run_turn("go", &mut ui).await.unwrap();

        assert!(
            agent.history()[0].text().contains("SUMMARY-TEXT"),
            "a memo-store failure must not roll back the summary"
        );
        assert!(store.all().unwrap().is_empty());
        assert!(
            ui.notices.iter().any(|notice| {
                notice.contains("failed to store 1 of 1 memory memo(s) from compaction")
            }),
            "notices: {:?}",
            ui.notices
        );
    }

    #[test]
    fn exit_sample_keeps_recent_messages_pitfall_windows_and_clips_text() {
        let mut history = Vec::new();
        history.push(Message::user("ctx-before"));
        history.push(Message::tool_result("c1", "error: pitfall-marker"));
        history.push(Message::user("ctx-after"));
        history.push(Message::user("still-near"));
        history.push(Message::user("NOT-IN-SAMPLE"));
        for index in 0..10 {
            if index == 3 {
                let mut message = Message::user("ignored");
                message.content = vec![
                    ContentPart::Text {
                        text: "alpha".to_string(),
                    },
                    ContentPart::Text {
                        text: "beta".to_string(),
                    },
                ];
                history.push(message);
            } else if index == 4 {
                history.push(Message::user("a".repeat(400)));
            } else {
                history.push(Message::user(format!("recent-{index}")));
            }
        }

        let sample = render_exit_sample(&history);
        assert!(sample.contains("[tool] error: pitfall-marker"));
        assert!(sample.contains("[user] ctx-before"));
        assert!(sample.contains("[user] alpha beta"));
        assert!(sample.contains(&"a".repeat(300)));
        assert!(!sample.contains(&"a".repeat(301)));
        assert!(!sample.contains("NOT-IN-SAMPLE"));
        assert!(sample.contains("[user] recent-9"));
    }

    #[test]
    fn exit_sample_keeps_only_the_newest_pitfall_window() {
        let mut history = Vec::new();
        for index in 0..30 {
            history.push(Message::tool_result(
                format!("c{index}"),
                format!("error: pit-{index:02}"),
            ));
        }
        for index in 0..10 {
            history.push(Message::user(format!("recent-{index}")));
        }

        let sample = render_exit_sample(&history);
        assert!(!sample.contains("pit-00"));
        assert!(sample.contains("pit-10"));
        assert!(sample.contains("recent-9"));
    }

    struct RecordingProvider {
        turns: Mutex<VecDeque<Result<Vec<StreamedMessagePart>, String>>>,
        systems: Mutex<Vec<String>>,
        prompts: Mutex<Vec<String>>,
        tool_counts: Mutex<Vec<usize>>,
    }

    #[async_trait]
    impl ChatProvider for RecordingProvider {
        fn name(&self) -> &str {
            "recording"
        }
        fn model_name(&self) -> &str {
            "recording-model"
        }
        async fn generate(
            &self,
            system_prompt: &str,
            tools: &[ToolDefinition],
            history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            self.systems.lock().unwrap().push(system_prompt.to_string());
            self.tool_counts.lock().unwrap().push(tools.len());
            self.prompts
                .lock()
                .unwrap()
                .push(history.first().map(Message::text).unwrap_or_default());
            let script = self
                .turns
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(Vec::new()));
            let parts = script.map_err(LlmError::Stream)?;
            let stream: BoxStream<Result<StreamedMessagePart, LlmError>> =
                Box::pin(futures_util::stream::iter(parts.into_iter().map(Ok)));
            let summary = StreamSummary {
                finish_reason: Some(FinishReason::Completed),
                ..StreamSummary::default()
            };
            Ok(StreamedMessage::new(stream, Arc::new(Mutex::new(summary))))
        }
    }

    #[tokio::test]
    async fn exit_extraction_appends_exit_memos_resolves_offered_pending_and_skips_a_repeat() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap());
        let mut pending = lmcode_memory::MemoryMemo::new(
            "继续修启动",
            "做到一半",
            "未完成",
            "old",
            ".",
            lmcode_memory::MemoKind::Pending,
            vec![],
        );
        pending.id = "pending-offered".to_string();
        let mut other_pending = lmcode_memory::MemoryMemo::new(
            "别的待办",
            "还没做",
            "未完成",
            "old",
            ".",
            lmcode_memory::MemoKind::Pending,
            vec![],
        );
        other_pending.id = "pending-keep".to_string();
        let mut task = lmcode_memory::MemoryMemo::new(
            "已完成的任务",
            "做过",
            "完成",
            "old",
            ".",
            lmcode_memory::MemoKind::Task,
            vec![],
        );
        task.id = "task-keep".to_string();
        store.append(&pending).unwrap();
        store.append(&other_pending).unwrap();
        store.append(&task).unwrap();

        let body = "\
```memory-memo
{\"userNeed\":\"退出时记住\",\"approach\":\"采样\",\"outcome\":\"完成\"}
```
```memory-resolve
{\"resolved\":[\"pending-offered\",\"invented\",\"task-keep\"]}
```
";
        let provider = Arc::new(RecordingProvider {
            turns: Mutex::new(VecDeque::from([Ok(vec![text_part(body)])])),
            systems: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            tool_counts: Mutex::new(Vec::new()),
        });
        let sessions = crate::session::SessionStore::with_root(dir.path().join("sessions"));
        let mut session = sessions.create(Path::new("."), "mock").unwrap();
        session.state.title = Some("退出试验".to_string());
        let session_id = session.id().to_string();

        let mut agent = Agent::new(provider.clone(), vec![], "system", PathBuf::from("."));
        agent.attach_memo_store(Arc::clone(&store));
        agent.attach_session(session);
        agent.history = vec![
            Message::user("one"),
            Message::user("two"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "three".to_string(),
                }],
                vec![],
            ),
            Message::user("four UNIQUE-OLD"),
        ];
        let before = agent.usage();
        agent.extract_memories_on_exit().await;
        let after = agent.usage();
        assert_eq!(before.llm_steps, after.llm_steps);
        assert_eq!(before.tool_calls, after.tool_calls);
        assert_eq!(before.compactions, after.compactions);
        assert_eq!(before.total.input_tokens, after.total.input_tokens);
        assert_eq!(before.total.output_tokens, after.total.output_tokens);

        assert_eq!(provider.tool_counts.lock().unwrap().as_slice(), &[0]);
        assert_eq!(
            provider.systems.lock().unwrap()[0],
            lmcode_memory::EXIT_EXTRACTION_SYSTEM_PROMPT
        );
        let prompt = provider.prompts.lock().unwrap()[0].clone();
        assert!(prompt.contains("共 4 条消息"), "{prompt}");
        assert!(prompt.contains("pending-offered"), "{prompt}");
        assert!(prompt.contains("[user] four UNIQUE-OLD"), "{prompt}");

        let created = store
            .all()
            .unwrap()
            .into_iter()
            .find(|memo| memo.user_need == "退出时记住")
            .expect("exit memo");
        assert_eq!(created.extraction_source, "exit");
        assert_eq!(created.source_session_id, session_id);
        assert_eq!(created.source_session_title.as_deref(), Some("退出试验"));
        assert_eq!(created.project_dir, ".");
        assert!(store.find_by_id("pending-offered").unwrap().is_none());
        assert!(store.find_by_id("pending-keep").unwrap().is_some());
        assert!(store.find_by_id("task-keep").unwrap().is_some());

        agent.extract_memories_on_exit().await;
        assert_eq!(provider.prompts.lock().unwrap().len(), 1);

        agent.clear_history();
        agent.history = vec![
            Message::user("fresh-a"),
            Message::user("fresh-b"),
            Message::user("fresh-c"),
            Message::user("fresh-d"),
        ];
        provider
            .turns
            .lock()
            .unwrap()
            .push_back(Ok(vec![text_part("```memory-memo\n{\"none\":true}\n```")]));
        agent.extract_memories_on_exit().await;
        let prompts = provider.prompts.lock().unwrap();
        assert_eq!(prompts.len(), 2);
        assert!(prompts[1].contains("fresh-d"));
        assert!(!prompts[1].contains("UNIQUE-OLD"));
    }

    #[tokio::test]
    async fn exit_extraction_skips_short_histories_and_retries_after_a_model_error() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap());
        let provider = Arc::new(RecordingProvider {
            turns: Mutex::new(VecDeque::from([
                Err("model down".to_string()),
                Ok(vec![text_part(
                    "```memory-memo\n{\"userNeed\":\"第二次成功\",\"approach\":\"重试\",\"outcome\":\"完成\"}\n```",
                )]),
            ])),
            systems: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            tool_counts: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(provider.clone(), vec![], "system", PathBuf::from("."));
        agent.attach_memo_store(Arc::clone(&store));
        agent.history = vec![
            Message::user("only"),
            Message::user("two"),
            Message::user("three"),
        ];
        agent.extract_memories_on_exit().await;
        assert!(provider.prompts.lock().unwrap().is_empty());

        agent.history.push(Message::user("four"));
        agent.extract_memories_on_exit().await;
        assert!(store.all().unwrap().is_empty());
        assert_eq!(provider.prompts.lock().unwrap().len(), 1);

        agent.extract_memories_on_exit().await;
        let memos = store.all().unwrap();
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "第二次成功");
        assert_eq!(memos[0].extraction_source, "exit");
        assert_eq!(memos[0].source_session_id, "unknown");

        agent.extract_memories_on_exit().await;
        assert_eq!(provider.prompts.lock().unwrap().len(), 2);
    }

    const QUESTION_ARGS: &str = r#"{"questions":[{"question":"Which database?","header":"Storage","options":[{"label":"Postgres","description":"Relational storage"},{"label":"SQLite","description":"Embedded storage"}]}]}"#;

    fn agent_asking(turns: Vec<Vec<StreamedMessagePart>>) -> Agent {
        let provider = Arc::new(MockProvider {
            turns: Mutex::new(VecDeque::from(turns)),
            seen: Mutex::new(Vec::new()),
        });
        Agent::new(
            provider,
            vec![Arc::new(crate::tools::AskUserQuestionTool::new())],
            "system prompt",
            PathBuf::from("."),
        )
    }

    struct QuestionUi {
        answer: crate::tools::ask_user::AskUserAnswer,
        asks: usize,
        approvals: usize,
        /// Notified from inside `ask_user`, after the turn is waiting on it.
        cancel_on_ask: Option<Arc<tokio::sync::Notify>>,
    }

    #[async_trait]
    impl TurnUi for QuestionUi {
        async fn text_delta(&mut self, _text: &str) {}
        async fn think_delta(&mut self, _text: &str) {}
        async fn tool_start(&mut self, _name: &str, _arguments: &str) {}
        async fn tool_end(&mut self, _name: &str, _ok: bool, _result: &str) {}
        async fn approve(&mut self, _name: &str, _arguments: &str) -> bool {
            self.approvals += 1;
            false
        }
        async fn ask_user(
            &mut self,
            _questions: &[crate::tools::ask_user::UserQuestion],
        ) -> crate::tools::ask_user::AskUserAnswer {
            self.asks += 1;
            if let Some(cancel) = &self.cancel_on_ask {
                cancel.notify_waiters();
                std::future::pending().await
            }
            self.answer.clone()
        }
        async fn notice(&mut self, _message: &str) {}
    }

    #[tokio::test]
    async fn ask_user_returns_answers_without_approval_or_the_method() {
        let mut agent = agent_asking(vec![
            vec![tool_call_part("call_q", "AskUserQuestion", QUESTION_ARGS)],
            vec![text_part("using sqlite")],
        ]);
        let mut ui = QuestionUi {
            answer: crate::tools::ask_user::AskUserAnswer::Payload(serde_json::json!({
                "answers": {"Which database?": "SQLite"},
                "method": "number_key"
            })),
            asks: 0,
            approvals: 0,
            cancel_on_ask: None,
        };

        let outcome = agent.run_turn("pick one", &mut ui).await.unwrap();

        assert_eq!(outcome.steps, 2);
        assert!(!outcome.interrupted);
        assert_eq!(ui.asks, 1);
        assert_eq!(ui.approvals, 0);
        assert_eq!(
            agent.history()[2].text(),
            r#"{"answers":{"Which database?":"SQLite"}}"#
        );
    }

    #[tokio::test]
    async fn ask_user_dismissal_is_a_successful_tool_result() {
        let mut agent = agent_asking(vec![
            vec![tool_call_part("call_q", "AskUserQuestion", QUESTION_ARGS)],
            vec![text_part("ok")],
        ]);
        let mut ui = QuestionUi {
            answer: crate::tools::ask_user::AskUserAnswer::Payload(serde_json::Value::Null),
            asks: 0,
            approvals: 0,
            cancel_on_ask: None,
        };

        agent.run_turn("pick one", &mut ui).await.unwrap();

        let result = agent.history()[2].text();
        assert!(result.contains("dismissed"), "{result}");
        assert!(result.contains("answers"), "{result}");
        assert!(!result.starts_with("error:"), "{result}");
    }

    #[tokio::test]
    async fn ask_user_unsupported_client_is_an_error_the_model_sees() {
        let mut agent = agent_asking(vec![
            vec![tool_call_part("call_q", "AskUserQuestion", QUESTION_ARGS)],
            vec![text_part("asked in text")],
        ]);
        let mut ui = MockUi::default();

        agent.run_turn("pick one", &mut ui).await.unwrap();

        assert_eq!(ui.approvals_requested, 0);
        let result = agent.history()[2].text();
        assert!(result.starts_with("error: "), "{result}");
        assert!(result.contains("connected client"), "{result}");
        assert!(
            result.contains("does not support interactive questions"),
            "{result}"
        );
        assert!(result.contains("Do NOT call this tool again"), "{result}");
        assert!(
            result.contains("Ask the user directly in your text response instead"),
            "{result}"
        );
    }

    #[tokio::test]
    async fn ask_user_transport_failure_is_an_error() {
        let mut agent = agent_asking(vec![
            vec![tool_call_part("call_q", "AskUserQuestion", QUESTION_ARGS)],
            vec![text_part("ok")],
        ]);
        let mut ui = QuestionUi {
            answer: crate::tools::ask_user::AskUserAnswer::Failed(
                "JSON-RPC question error response".to_string(),
            ),
            asks: 0,
            approvals: 0,
            cancel_on_ask: None,
        };

        agent.run_turn("pick one", &mut ui).await.unwrap();

        let result = agent.history()[2].text();
        assert!(result.starts_with("error: "), "{result}");
        assert!(result.contains("Failed to ask the user"), "{result}");
        assert!(
            result.contains("JSON-RPC question error response"),
            "{result}"
        );
    }

    #[tokio::test]
    async fn ask_user_rejects_invalid_questions_without_asking() {
        let mut agent = agent_asking(vec![
            vec![tool_call_part(
                "call_q",
                "AskUserQuestion",
                r#"{"questions":[]}"#,
            )],
            vec![text_part("ok")],
        ]);
        let mut ui = QuestionUi {
            answer: crate::tools::ask_user::AskUserAnswer::Unsupported,
            asks: 0,
            approvals: 0,
            cancel_on_ask: None,
        };

        agent.run_turn("pick one", &mut ui).await.unwrap();

        assert_eq!(ui.asks, 0);
        assert!(agent.history()[2].text().starts_with("error: "));
    }

    #[tokio::test]
    async fn ask_user_cancel_interrupts_the_turn_and_rolls_back() {
        let mut agent = agent_asking(vec![vec![tool_call_part(
            "call_q",
            "AskUserQuestion",
            QUESTION_ARGS,
        )]]);
        let cancel = Arc::new(tokio::sync::Notify::new());
        agent.set_cancel_signal(Arc::clone(&cancel));
        let mut ui = QuestionUi {
            answer: crate::tools::ask_user::AskUserAnswer::Unsupported,
            asks: 0,
            approvals: 0,
            cancel_on_ask: Some(cancel),
        };

        let outcome = agent.run_turn("pick one", &mut ui).await.unwrap();

        assert!(outcome.interrupted);
        assert_eq!(ui.asks, 1);
        assert!(agent.history().is_empty());
    }

    struct ImageTool;

    #[async_trait]
    impl Tool for ImageTool {
        fn name(&self) -> &str {
            "ShowImage"
        }
        fn description(&self) -> &str {
            "Return one image part"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            serde_json::json!({"type": "object", "properties": {}})
        }
        fn requires_approval(&self) -> bool {
            false
        }
        async fn execute(
            &self,
            _arguments: &serde_json::Value,
            _cwd: &Path,
        ) -> Result<String, String> {
            Ok("see image".to_string())
        }
        async fn execute_rich(
            &self,
            _arguments: &serde_json::Value,
            _cwd: &Path,
        ) -> Result<crate::tools::ToolResult, String> {
            use lmcode_llm::message::{ContentPart, ImageUrl};
            Ok(crate::tools::ToolResult::parts(
                vec![
                    ContentPart::Text {
                        text: "<system>Read image file.</system>".to_string(),
                    },
                    ContentPart::ImageUrl {
                        image_url: ImageUrl {
                            url: "data:image/png;base64,aaaa".to_string(),
                            id: None,
                        },
                    },
                ],
                true,
            ))
        }
    }

    #[tokio::test]
    async fn tool_image_parts_stay_on_the_tool_result_message() {
        let provider = Arc::new(MockProvider {
            turns: Mutex::new(VecDeque::from(vec![
                vec![tool_call_part("call_img", "ShowImage", "{}")],
                vec![text_part("saw it")],
            ])),
            seen: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(
            provider,
            vec![Arc::new(ImageTool)],
            "system prompt",
            PathBuf::from("."),
        );
        let mut ui = MockUi::default();
        agent.run_turn("look", &mut ui).await.unwrap();
        let result = &agent.history()[2];
        assert_eq!(result.role, Role::Tool);
        assert!(result.text().contains("<system>Read image file.</system>"));
        assert!(result.content.iter().any(|part| matches!(
            part,
            lmcode_llm::message::ContentPart::ImageUrl { image_url }
                if image_url.url == "data:image/png;base64,aaaa"
        )));
    }

    fn overflow_error() -> LlmError {
        LlmError::Api {
            status: 400,
            message: "Context length exceeded".to_string(),
            retry_after_ms: None,
        }
    }

    #[tokio::test]
    async fn context_overflow_compacts_once_instead_of_retrying_three_times() {
        let overflows = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let seen = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let overflows_call = Arc::clone(&overflows);
        let seen_call = Arc::clone(&seen);
        let provider = Arc::new(OverflowProvider {
            overflows: overflows_call,
            seen: seen_call,
        });
        let mut agent = Agent::new(
            provider,
            vec![Arc::new(EchoTool {
                requires_approval: false,
            })],
            "system prompt",
            PathBuf::from("."),
        );
        agent.history = vec![
            Message::user("old user one"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "old assistant one".to_string(),
                }],
                vec![],
            ),
        ];
        let mut ui = MockUi::default();
        let outcome = agent
            .run_turn("Retry after provider overflow", &mut ui)
            .await
            .unwrap();

        assert!(!outcome.interrupted);
        assert_eq!(overflows.load(std::sync::atomic::Ordering::SeqCst), 1);
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter().any(|history| {
                history.iter().any(|text| text.contains("direct task"))
                    && history.iter().any(|text| text.contains("old user one"))
            }),
            "compaction call missing: {seen:?}"
        );
        assert!(
            seen.last().is_some_and(|history| {
                history
                    .iter()
                    .any(|text| text.contains("Overflow compacted summary."))
                    && history
                        .iter()
                        .any(|text| text.contains("Retry after provider overflow"))
            }),
            "recovery call missing: {seen:?}"
        );
        assert!(agent.history().iter().any(|message| {
            message
                .text()
                .contains("Recovered after overflow compaction.")
        }));
        agent.undo(10);
        assert_eq!(agent.history().len(), 1);
        assert!(
            agent.history()[0]
                .text()
                .contains("Overflow compacted summary.")
        );
        assert!(matches!(
            agent.history()[0].origin,
            Some(MessageOrigin::CompactionSummary)
        ));
    }

    struct OverflowProvider {
        overflows: Arc<std::sync::atomic::AtomicU32>,
        seen: Arc<Mutex<Vec<Vec<String>>>>,
    }

    #[async_trait]
    impl ChatProvider for OverflowProvider {
        fn name(&self) -> &str {
            "overflow"
        }
        fn model_name(&self) -> &str {
            "overflow-model"
        }
        async fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[ToolDefinition],
            history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            let texts: Vec<String> = history.iter().map(|message| message.text()).collect();
            self.seen.lock().unwrap().push(texts.clone());
            let blob = texts.join("\n");
            let parts = if blob.contains("direct task") {
                vec![text_part("Overflow compacted summary.")]
            } else if blob.contains("Overflow compacted summary.") {
                vec![text_part("Recovered after overflow compaction.")]
            } else if blob.contains("Retry after provider overflow") {
                self.overflows
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Err(overflow_error());
            } else {
                return Err(LlmError::Api {
                    status: 400,
                    message: format!("unexpected history: {blob}"),
                    retry_after_ms: None,
                });
            };
            let stream: BoxStream<Result<StreamedMessagePart, LlmError>> =
                Box::pin(futures_util::stream::iter(parts.into_iter().map(Ok)));
            Ok(StreamedMessage::new(
                stream,
                Arc::new(Mutex::new(StreamSummary {
                    finish_reason: Some(FinishReason::Completed),
                    ..StreamSummary::default()
                })),
            ))
        }
    }

    #[tokio::test]
    async fn context_overflow_surfaces_when_there_is_nothing_to_compact() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_for_provider = Arc::clone(&calls);
        let provider = Arc::new(FailProvider {
            calls: calls_for_provider,
        });
        let mut agent = Agent::new(provider, Vec::new(), "system prompt", PathBuf::from("."));
        let mut ui = MockUi::default();
        let error = agent
            .run_turn("only one message", &mut ui)
            .await
            .unwrap_err();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let CoreError::Llm(error) = error else {
            panic!("expected the overflow to surface");
        };
        assert!(is_context_overflow(&error));
        assert!(agent.history().is_empty());
    }

    #[tokio::test]
    async fn retries_a_transient_error_once_and_keeps_the_turn() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_for_provider = Arc::clone(&calls);
        let provider = Arc::new(FailThenText {
            calls: calls_for_provider,
        });
        let mut agent = Agent::new(provider, Vec::new(), "system prompt", PathBuf::from("."));
        let mut ui = MockUi::default();
        let outcome = agent.run_turn("please retry", &mut ui).await.unwrap();
        assert_eq!(outcome.steps, 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(
            agent
                .history()
                .iter()
                .any(|message| message.text() == "please retry")
        );
        assert!(
            agent
                .history()
                .iter()
                .any(|message| message.text() == "second try")
        );
    }

    struct FailProvider {
        calls: Arc<std::sync::atomic::AtomicU32>,
    }

    #[async_trait]
    impl ChatProvider for FailProvider {
        fn name(&self) -> &str {
            "fail"
        }
        fn model_name(&self) -> &str {
            "fail-model"
        }
        async fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[ToolDefinition],
            _history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(overflow_error())
        }
    }

    struct FailThenText {
        calls: Arc<std::sync::atomic::AtomicU32>,
    }

    #[async_trait]
    impl ChatProvider for FailThenText {
        fn name(&self) -> &str {
            "fail-then"
        }
        fn model_name(&self) -> &str {
            "fail-then-model"
        }
        async fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[ToolDefinition],
            _history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                return Err(LlmError::Api {
                    status: 503,
                    message: "unavailable".to_string(),
                    retry_after_ms: Some(0),
                });
            }
            let stream: BoxStream<Result<StreamedMessagePart, LlmError>> = Box::pin(
                futures_util::stream::iter(vec![text_part("second try")].into_iter().map(Ok)),
            );
            Ok(StreamedMessage::new(
                stream,
                Arc::new(Mutex::new(StreamSummary {
                    finish_reason: Some(FinishReason::Completed),
                    ..StreamSummary::default()
                })),
            ))
        }
    }

    #[tokio::test]
    async fn steer_during_a_turn_reaches_the_next_model_request() {
        let provider = Arc::new(SteerProvider {
            slot: Mutex::new(None),
            seen: Mutex::new(Vec::new()),
        });
        let mut agent = Agent::new(
            provider.clone(),
            vec![Arc::new(EchoTool {
                requires_approval: false,
            })],
            "system prompt",
            PathBuf::from("."),
        );
        *provider.slot.lock().unwrap() = Some(agent.steer_slot());
        let mut ui = MockUi::default();
        agent.run_turn("look", &mut ui).await.unwrap();
        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[1].iter().any(|text| text == "Also mention the steer."));
        assert!(
            agent
                .history()
                .iter()
                .any(|message| message.text() == "Also mention the steer.")
        );
    }

    struct SteerProvider {
        slot: Mutex<Option<Arc<SteerSlot>>>,
        seen: Mutex<Vec<Vec<String>>>,
    }

    #[async_trait]
    impl ChatProvider for SteerProvider {
        fn name(&self) -> &str {
            "steer"
        }
        fn model_name(&self) -> &str {
            "steer-model"
        }
        async fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[ToolDefinition],
            history: &[Message],
            _options: GenerateOptions,
        ) -> Result<StreamedMessage, LlmError> {
            let texts: Vec<String> = history.iter().map(|message| message.text()).collect();
            let first = self.seen.lock().unwrap().is_empty();
            self.seen.lock().unwrap().push(texts);
            let reply = if first {
                if let Some(slot) = self.slot.lock().unwrap().clone() {
                    assert!(slot.submit("Also mention the steer."));
                }
                "Capturing."
            } else {
                "Approved, and I saw the steer."
            };
            let stream: BoxStream<Result<StreamedMessagePart, LlmError>> = Box::pin(
                futures_util::stream::iter(vec![text_part(reply)].into_iter().map(Ok)),
            );
            Ok(StreamedMessage::new(
                stream,
                Arc::new(Mutex::new(StreamSummary {
                    finish_reason: Some(FinishReason::Completed),
                    ..StreamSummary::default()
                })),
            ))
        }
    }

    #[tokio::test]
    async fn steer_while_idle_starts_a_turn_and_an_active_steer_does_not() {
        let mut agent = agent_with(
            vec![vec![text_part("done")]],
            EchoTool {
                requires_approval: false,
            },
            4,
        );
        let mut ui = MockUi::default();
        let started = agent.steer("hello", &mut ui).await.unwrap();
        assert!(started.is_some());
        assert!(
            agent
                .history()
                .iter()
                .any(|message| message.text() == "hello")
        );

        agent.steer.active.store(true, Ordering::SeqCst);
        let buffered = agent.steer("later", &mut ui).await.unwrap();
        assert!(buffered.is_none());
        assert!(
            !agent
                .history()
                .iter()
                .any(|message| message.text() == "later")
        );
        assert_eq!(agent.steer.pending.lock().unwrap()[0].text(), "later");
    }

    #[tokio::test]
    async fn queued_injection_is_skipped_by_undo() {
        let mut agent = agent_with(
            vec![vec![text_part("done")]],
            EchoTool {
                requires_approval: false,
            },
            4,
        );
        agent.queue_injection("remember this".to_string());
        let mut ui = MockUi::default();
        agent.run_turn("real prompt", &mut ui).await.unwrap();
        agent.undo(1);
        assert_eq!(agent.history().len(), 1);
        assert_eq!(agent.history()[0].text(), "remember this");
        assert!(matches!(
            agent.history()[0].origin,
            Some(MessageOrigin::Injection { .. })
        ));
    }

    #[test]
    fn undo_stops_at_a_compaction_summary_and_counts_user_slash_skills() {
        let mut agent = agent_with(
            vec![],
            EchoTool {
                requires_approval: false,
            },
            4,
        );
        agent.history = vec![
            user_prompt("ancient"),
            Message::assistant(vec![text_content("old")], vec![])
                .with_origin(MessageOrigin::CompactionSummary),
            user_prompt("turn one"),
            Message::assistant(vec![text_content("answer one")], vec![]),
            injection_message("injected"),
            Message::user("slash skill").with_origin(MessageOrigin::SkillActivation {
                trigger: "user-slash".to_string(),
            }),
            Message::assistant(vec![text_content("answer slash")], vec![]),
            Message::user("model skill").with_origin(MessageOrigin::SkillActivation {
                trigger: "model".to_string(),
            }),
            user_prompt("turn latest"),
            Message::assistant(vec![text_content("answer latest")], vec![]),
        ];

        agent.undo(0);
        assert_eq!(agent.history().len(), 10);

        agent.undo(1);
        assert_eq!(agent.history().last().unwrap().text(), "model skill");

        agent.undo(1);
        assert_eq!(agent.history().last().unwrap().text(), "injected");
        assert!(
            agent
                .history()
                .iter()
                .any(|message| message.text() == "turn one")
        );

        agent.undo(1);
        assert_eq!(
            agent
                .history()
                .iter()
                .map(|message| message.text())
                .collect::<Vec<_>>(),
            vec!["ancient", "old", "injected"]
        );
        assert!(matches!(
            agent.history()[1].origin,
            Some(MessageOrigin::CompactionSummary)
        ));

        agent.undo(5);
        assert_eq!(
            agent
                .history()
                .iter()
                .map(|message| message.text())
                .collect::<Vec<_>>(),
            vec!["ancient", "old", "injected"]
        );
    }

    fn text_content(text: &str) -> ContentPart {
        ContentPart::Text {
            text: text.to_string(),
        }
    }

    #[tokio::test]
    async fn a_turn_injects_the_computer_use_contract_preferences_and_pending_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap());
        let preference = lmcode_memory::MemoryMemo::new(
            "所有会话",
            "回复用中文",
            "已记录为长期偏好",
            "session-1",
            "",
            MemoKind::Preference,
            vec!["偏好".to_string(), "沟通".to_string()],
        );
        let pending = lmcode_memory::MemoryMemo::new(
            "修复 flaky test",
            "已定位到文件锁",
            "未完成",
            "session-1",
            "",
            MemoKind::Pending,
            Vec::new(),
        );
        store.append(&preference).unwrap();
        store.append(&pending).unwrap();

        let mut agent = agent_with(
            vec![vec![text_part("done")], vec![text_part("still done")]],
            EchoTool {
                requires_approval: false,
            },
            4,
        );
        agent.attach_memo_store(Arc::clone(&store));
        agent.set_computer_use_active(true);
        let mut ui = MockUi::default();
        agent.run_turn("look at the window", &mut ui).await.unwrap();

        let texts: Vec<String> = agent.history().iter().map(Message::text).collect();
        let contract = texts
            .iter()
            .filter(|text| text.contains("get_window_state"))
            .count();
        assert_eq!(contract, 1, "{texts:?}");
        assert!(texts.iter().any(|text| text.contains("not withdrawn")));
        assert!(
            texts
                .iter()
                .any(|text| text.contains("回复用中文") && text.contains("MemoryWrite"))
        );
        assert!(
            texts
                .iter()
                .any(|text| text.contains("修复 flaky test") && text.contains("销账"))
        );

        agent.run_turn("again", &mut ui).await.unwrap();
        let texts: Vec<String> = agent.history().iter().map(Message::text).collect();
        // A new user message restates the operating contract. The preference
        // list and the pending briefing stay as they were.
        assert_eq!(
            texts
                .iter()
                .filter(|text| text.contains("get_window_state"))
                .count(),
            2,
            "{texts:?}"
        );
        assert_eq!(texts.iter().filter(|text| text.contains("销账")).count(), 1);
        assert_eq!(
            texts
                .iter()
                .filter(|text| text.contains("MemoryWrite"))
                .count(),
            1
        );
    }
}
