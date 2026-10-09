//! Minimal agent turn loop — the Rust seed of `packages/agent-core`'s turn engine.
//!
//! One user turn: stream a model response, execute any requested tool calls
//! (asking for approval when required), feed the results back, and repeat
//! until the model replies without tool calls or the step limit is hit.

use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message, Role, StreamedMessagePart, ToolCall};
use lmcode_llm::provider::{ChatProvider, GenerateOptions};
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
use crate::session::Session;
use crate::tools::{Tool, ToolResult};

const DEFAULT_MAX_STEPS: usize = 50;

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
        // Flush queued injections (cron fires) before the user input.
        let injections = std::mem::take(&mut self.injections);
        for injection in injections {
            self.history.push(Message::user(&injection));
        }
        self.history.push(Message::user_with_images(input, images));

        let mut steps = 0usize;
        loop {
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
                .provider
                .generate(
                    &self.system_prompt_with_injections().await,
                    &tool_definitions,
                    &projected,
                    GenerateOptions::default(),
                )
                .await
            {
                Ok(stream) => stream,
                Err(error) => {
                    self.session_memory.record_error(&error.to_string());
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
        let mut new_history = Vec::with_capacity(self.history.len() - split + 1);
        new_history.push(Message::user(format!(
            "[Context compaction] The earlier conversation was summarized:\n\n{summary}"
        )));
        new_history.extend_from_slice(&self.history[split..]);
        self.history = new_history;
        self.pipeline.reset_micro();
        // Memo extraction must not sink a summary that is already committed.
        self.compaction_memo_warning = self.store_compaction_memos(&summary);
        Ok(true)
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
            .provider
            .generate(
                system,
                &[],
                &[Message::user(prompt)],
                GenerateOptions::default(),
            )
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
}
