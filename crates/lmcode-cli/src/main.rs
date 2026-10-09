//! LMcode CLI — Rust rewrite of `apps/lmcode`.
//!
//! Interactive REPL around the minimal agent loop: streams responses, shows
//! reasoning and tool activity, and asks for approval before commands run.

mod channel;
mod export;
mod stream_json;
mod ui;

use std::io::IsTerminal;
use std::sync::Arc;

use clap::Parser;
use lmcode_core::agent::{Agent, wait_for_ctrl_c};
use lmcode_core::config::{load_config, resolve_model};
use lmcode_core::session::SessionStore;
use lmcode_core::tools::{
    AskUserQuestionTool, BashTool, EditTool, GlobTool, GrepTool, MemoryConsolidateApplyTool,
    MemoryConsolidatePlanTool, MemoryEditTool, MemoryLookupTool, MemoryWriteTool, MultiEditTool,
    ReadGroupTool, ReadMediaFileTool, ReadTool, SkillTool, TaskListTool, TaskStopTool, TodoList,
    TodoListTool, Tool, WriteTool,
};
use lmcode_llm::providers::create_provider;
use lmcode_memory::MemoStore;
use ui::TerminalUi;

const SYSTEM_PROMPT: &str = include_str!("system.md");

/// LMcode — interactive coding agent (Rust rewrite).
#[derive(Debug, Parser)]
#[command(name = "lm", version, about = "LMcode CLI (Rust rewrite)")]
struct Cli {
    /// One-shot prompt text (same as `-p`; quote multi-word prompts).
    #[arg(value_name = "PROMPT")]
    prompt_parts: Vec<String>,

    /// Run a single prompt non-interactively and exit. A bare `-p` still
    /// means prompt mode (validated as an empty prompt, like the legacy CLI).
    #[arg(
        short = 'p',
        long = "prompt",
        value_name = "PROMPT",
        num_args = 0..=1,
        default_missing_value = ""
    )]
    prompt: Option<String>,

    /// Model alias from config.toml (defaults to `default_model`).
    #[arg(short = 'm', long)]
    model: Option<String>,

    /// Path to config.toml (defaults to $LMCODE_HOME/config.toml or ~/.lmcode/config.toml).
    #[arg(long)]
    config: Option<std::path::PathBuf>,

    /// Auto-approve every tool call (non-interactive / automation mode).
    #[arg(short = 'y', long)]
    yolo: bool,

    /// Hidden compatibility alias for `--yolo`.
    #[arg(long = "yes", hide = true)]
    yes: bool,

    /// Hidden compatibility alias for `--yolo`.
    #[arg(long = "auto-approve", hide = true)]
    auto_approve: bool,

    /// Start in auto permission mode: non-sensitive calls are approved
    /// without prompting; calls touching sensitive paths still ask.
    #[arg(long)]
    auto: bool,

    /// Continue the most recent session for this directory.
    #[arg(short = 'C', long = "continue", visible_short_alias = 'c')]
    continue_session: bool,

    /// Resume a session: with an ID, load that session; without one, the
    /// most recent session for this directory.
    #[arg(short = 'S', long = "session", value_name = "ID", num_args = 0..=1, default_missing_value = "")]
    session: Option<String>,

    /// Alias of `-S/--session`.
    #[arg(short = 'r', long = "resume", value_name = "ID", num_args = 0..=1, default_missing_value = "")]
    resume: Option<String>,

    /// Start in plan mode.
    #[arg(long)]
    plan: bool,

    /// Load skills from these directories instead of auto-discovery
    /// (repeatable).
    #[arg(long = "skills-dir", value_name = "DIR")]
    skills_dirs: Vec<std::path::PathBuf>,

    /// Output format for prompt mode (defaults to text).
    #[arg(long = "output-format", value_enum)]
    output_format: Option<OutputFormat>,

    /// Launch the full-screen TUI (requires an interactive terminal).
    #[arg(long)]
    tui: bool,

    /// Sub-commands (session export, …).
    #[command(subcommand)]
    command: Option<CliCommand>,
}

/// Sub-commands mirroring the legacy CLI's commander commands.
///
/// Variant sizes differ a lot (StreamJson carries the whole cc-connect flag
/// set); the enum is built once per process, so the size difference is
/// irrelevant.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, clap::Subcommand)]
enum CliCommand {
    /// 导出会话为 ZIP 压缩包。
    Export {
        /// 要导出的会话 ID。默认使用最近的会话。
        #[arg(value_name = "SESSION_ID")]
        session_id: Option<String>,
        /// 输出 ZIP 路径。
        #[arg(short = 'o', long, value_name = "PATH")]
        output: Option<std::path::PathBuf>,
        /// 跳过历史会话确认。
        #[arg(short = 'y', long)]
        yes: bool,
        /// 不打包全局诊断日志（默认会包含，如存在）。
        #[arg(long = "no-include-global-log")]
        no_include_global_log: bool,
    },

    /// 管理 cc-connect 消息平台通道。
    Channel {
        #[command(subcommand)]
        action: ChannelAction,
    },

    /// 将旧版 lmcode-cli 安装的数据迁移到 lmcode。（已停用）
    Migrate,

    /// Hidden sub-command for the cc-connect / Claude Code stream-json
    /// protocol: reads user messages on stdin, emits NDJSON events.
    #[command(hide = true)]
    StreamJson {
        #[arg(long = "input-format")]
        input_format: Option<String>,
        #[arg(long = "output-format")]
        output_format: Option<String>,
        #[arg(long)]
        resume: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long = "permission-mode")]
        permission_mode: Option<String>,
        #[arg(long = "permission-prompt-tool")]
        permission_prompt_tool: Option<String>,
        #[arg(long = "replay-user-messages")]
        replay_user_messages: bool,
        #[arg(long)]
        verbose: bool,
        #[arg(long = "system-prompt")]
        system_prompt: Option<String>,
        #[arg(long = "append-system-prompt")]
        append_system_prompt: Option<String>,
        #[arg(long = "append-system-prompt-file")]
        append_system_prompt_file: Option<std::path::PathBuf>,
        #[arg(long = "allowedTools")]
        allowed_tools: Option<String>,
        #[arg(long = "disallowedTools")]
        disallowed_tools: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long = "max-context-tokens")]
        max_context_tokens: Option<u64>,
        #[arg(long = "skills-dir")]
        skills_dirs: Vec<std::path::PathBuf>,
    },
}

/// `lm channel <action>`.
#[derive(Debug, clap::Subcommand)]
enum ChannelAction {
    /// 配置 cc-connect 并选择要连接的平台。
    Setup,
}

/// Prompt-mode output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum OutputFormat {
    /// Plain text (default).
    Text,
    /// One JSON event per line (Claude Code stream-json compatible).
    StreamJson,
}

impl Cli {
    /// The effective one-shot prompt: `-p/--prompt`, or the positional parts.
    fn effective_prompt(&self) -> Option<String> {
        // Mirrors the legacy behaviour: a bare `-p` (empty value) still
        // counts as prompt mode, and a trailing positional fills the prompt —
        // including the regression case `-p --output-format stream-json
        // "explain this repo"` where `-p` swallows nothing and the positional
        // becomes the prompt.
        match &self.prompt {
            Some(prompt) if !prompt.is_empty() => Some(prompt.clone()),
            Some(_) if !self.prompt_parts.is_empty() => Some(self.prompt_parts.join(" ")),
            Some(_) => Some(String::new()),
            None if !self.prompt_parts.is_empty() => Some(self.prompt_parts.join(" ")),
            None => None,
        }
    }

    /// Effective session request: `--session` wins over its `--resume` alias.
    /// `Some("")` means "no ID given" (pick the most recent session).
    fn session_request(&self) -> Option<&str> {
        self.session.as_deref().or(self.resume.as_deref())
    }

    /// Whether `--yolo` (or a hidden compatibility alias) was given.
    fn yolo_requested(&self) -> bool {
        self.yolo || self.yes || self.auto_approve
    }
}

/// Option-conflict validation, ported from the legacy CLI's
/// `validateOptions` (same messages, same cases).
fn validate_options(cli: &Cli) -> Result<(), String> {
    let prompt = cli.effective_prompt();
    let prompt_mode = prompt.is_some();
    if let Some(prompt) = &prompt
        && prompt.trim().is_empty()
    {
        return Err("提示不能为空。".to_string());
    }
    if let Some(model) = &cli.model
        && model.trim().is_empty()
    {
        return Err("模型不能为空。".to_string());
    }
    if !prompt_mode && cli.output_format.is_some() {
        return Err("输出格式仅在提示模式下支持。".to_string());
    }
    // --yolo / --auto are redundant in prompt mode (it always forces auto
    // permission with headless approval), so they pass through as no-ops
    // instead of erroring — habit-compatible with `lm -p "..." -y`.
    if prompt_mode && cli.plan {
        return Err("--prompt 不能与 --plan 同时使用。".to_string());
    }
    if prompt_mode && cli.session.as_deref() == Some("") {
        return Err("在提示模式下不能使用不带 ID 的 --session。".to_string());
    }
    if cli.continue_session && cli.session_request().is_some() {
        return Err("--continue 和 --session 不能同时使用。".to_string());
    }
    if cli.yolo_requested() && cli.auto {
        return Err("--yolo 不能与 --auto 同时使用。".to_string());
    }
    let resuming = cli.continue_session || cli.session_request().is_some();
    if !prompt_mode && resuming && cli.yolo_requested() {
        return Err("--yolo 不能与 --continue 或 --session 同时使用。".to_string());
    }
    if !prompt_mode && resuming && cli.auto {
        return Err("--auto 不能与 --continue 或 --session 同时使用。".to_string());
    }
    if !prompt_mode && resuming && cli.plan {
        return Err("--plan 不能与 --continue 或 --session 同时使用。".to_string());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            // Match the legacy CLI's exit codes (commander exits 1 for
            // unknown/invalid options; help/version display exits 0).
            use clap::error::ErrorKind;
            let _ = error.print();
            match error.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => std::process::exit(0),
                ErrorKind::UnknownArgument | ErrorKind::InvalidValue => std::process::exit(1),
                _ => std::process::exit(2),
            }
        }
    };

    // Sub-commands run before any config/provider setup (they need neither).
    if let Some(command) = cli.command {
        match command {
            CliCommand::Export {
                session_id,
                output,
                yes,
                no_include_global_log,
            } => {
                let code = export::run_export(
                    session_id.as_deref(),
                    output.as_deref(),
                    yes,
                    no_include_global_log,
                );
                std::process::exit(code);
            }
            CliCommand::Channel {
                action: ChannelAction::Setup,
            } => {
                let code = channel::run_channel_setup();
                std::process::exit(code);
            }
            CliCommand::Migrate => {
                // Permanently disabled, kept for backwards compatibility
                // (same notice and exit code as the legacy CLI).
                println!("迁移功能已取消，不再支持从 lmcode-cli 导入数据。");
                std::process::exit(0);
            }
            CliCommand::StreamJson {
                resume,
                model,
                append_system_prompt,
                append_system_prompt_file,
                skills_dirs,
                ..
            } => {
                // `--append-system-prompt-file` content is appended after the
                // inline `--append-system-prompt` text (legacy order).
                let mut append_system_prompt = append_system_prompt;
                if let Some(path) = &append_system_prompt_file {
                    match std::fs::read_to_string(path) {
                        Ok(content) => {
                            append_system_prompt = Some(match append_system_prompt {
                                Some(existing) => format!("{existing}\n{content}"),
                                None => content,
                            });
                        }
                        Err(error) => eprintln!(
                            "[stream-json] warning: cannot read --append-system-prompt-file: {error}"
                        ),
                    }
                }
                stream_json::run_stream_json(stream_json::StreamJsonCommand {
                    resume,
                    model,
                    append_system_prompt,
                    skills_dirs,
                })
                .await?;
                return Ok(());
            }
        }
    }

    if let Err(message) = validate_options(&cli) {
        // Same prefix and exit code as the legacy CLI's OptionConflictError
        // path (`错误：…`, exit 1).
        eprintln!("错误：{message}");
        std::process::exit(1);
    }

    let config = load_config(cli.config.as_deref())?;
    let resolved = resolve_model(&config, cli.model.as_deref())?;
    let display_name = resolved.display_name.clone();
    let max_context_size = resolved.max_context_size;
    let max_output_size = resolved.max_output_size;
    #[cfg(feature = "local-embeddings")]
    let embedding_engine: Option<Arc<dyn lmcode_memory::EmbeddingEngine>> =
        Some(Arc::new(lmcode_memory::LocalEmbeddingEngine::new()));
    #[cfg(not(feature = "local-embeddings"))]
    let embedding_engine: Option<Arc<dyn lmcode_memory::EmbeddingEngine>> =
        Some(Arc::new(lmcode_memory::OpenAiEmbeddingEngine::new(
            resolved.base_url.clone(),
            resolved.api_key.clone(),
            None,
        )));
    let provider = create_provider(resolved.into_provider_config())?;

    let cwd = std::env::current_dir()?;
    let mut ui = TerminalUi::new();
    ui.set_auto_approve(cli.yolo_requested());
    if cli.auto {
        ui.set_auto_mode(true);
    }

    // Session first: the memory tools need the session id.
    let session_store = SessionStore::new();
    let session = if let Some(id) = cli.session_request() {
        if id.is_empty() {
            match session_store.latest(&cwd)? {
                Some(session) => {
                    ui.info(&format!(
                        "resuming session {} ({} messages)",
                        session.id(),
                        session.messages.len()
                    ));
                    session
                }
                None => {
                    ui.info("no previous session for this directory; starting a new one");
                    session_store.create(&cwd, &display_name)?
                }
            }
        } else {
            match session_store.load(&cwd, id) {
                Ok(session) => {
                    ui.info(&format!(
                        "resuming session {} ({} messages)",
                        session.id(),
                        session.messages.len()
                    ));
                    session
                }
                Err(error) => {
                    eprintln!("error: cannot load session {id}: {error}");
                    std::process::exit(1);
                }
            }
        }
    } else if cli.continue_session {
        match session_store.latest(&cwd)? {
            Some(session) => {
                ui.info(&format!(
                    "resuming session {} ({} messages)",
                    session.id(),
                    session.messages.len()
                ));
                session
            }
            None => {
                ui.info("no previous session for this directory; starting a new one");
                session_store.create(&cwd, &display_name)?
            }
        }
    } else {
        session_store.create(&cwd, &display_name)?
    };
    let session_id = session.id().to_string();

    // Background tasks: shared between the Bash tool and TaskOutput.
    let background = Arc::new(lmcode_core::background::BackgroundTaskManager::new(
        lmcode_core::config::lmcode_home().join("tasks"),
    ));
    // LSP: language servers start lazily per workspace + language.
    let lsp_registry = Arc::new(lmcode_core::lsp::LspRegistry::default());
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(ReadTool),
        Arc::new(BashTool::with_background(Arc::clone(&background))),
        Arc::new(WriteTool),
        Arc::new(EditTool),
        Arc::new(GrepTool),
        Arc::new(GlobTool),
        Arc::new(lmcode_core::tools::task_output::TaskOutputTool::new(
            Arc::clone(&background),
        )),
        Arc::new(TaskListTool::new(Arc::clone(&background))),
        Arc::new(TaskStopTool::new(Arc::clone(&background))),
        Arc::new(MultiEditTool),
        Arc::new(ReadGroupTool),
        Arc::new(TodoListTool::new(TodoList::new())),
        // FetchURL ships a real fetcher; WebSearch needs a provider and is
        // registered only when the host supplies one (mirrors the TS
        // host-injection contract).
        Arc::new(lmcode_core::tools::web::FetchUrlTool::new()),
        Arc::new(lmcode_core::tools::lsp::LspTool::new(Arc::clone(
            &lsp_registry,
        ))),
    ];
    if let Some(media) = ReadMediaFileTool::new(true, false) {
        tools.push(Arc::new(media));
    }
    // Plan mode: the handle is shared between the plan tools and the agent.
    let plan_handle: lmcode_core::tools::planning::PlanHandle = Arc::new(tokio::sync::Mutex::new(
        lmcode_core::plan::PlanMode::default(),
    ));
    tools.push(Arc::new(
        lmcode_core::tools::planning::EnterPlanModeTool::new(Arc::clone(&plan_handle)),
    ));
    tools.push(Arc::new(
        lmcode_core::tools::planning::ExitPlanModeTool::new(Arc::clone(&plan_handle)),
    ));
    // Goal mode: durable state persisted under the LMcode home.
    let goal_handle: lmcode_core::tools::goal::GoalHandle = Arc::new(tokio::sync::Mutex::new(
        lmcode_core::goal::GoalMode::with_path(
            lmcode_core::config::lmcode_home()
                .join("goals")
                .join("current.json"),
        ),
    ));
    tools.push(Arc::new(lmcode_core::tools::goal::CreateGoalTool::new(
        Arc::clone(&goal_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::goal::GetGoalTool::new(
        Arc::clone(&goal_handle),
    )));
    tools.push(Arc::new(lmcode_core::tools::goal::SetGoalBudgetTool::new(
        Arc::clone(&goal_handle),
    )));
    // The goal grader shares the provider and the agent's evidence snapshot.
    let evidence_snapshot = Arc::new(tokio::sync::Mutex::new(String::new()));
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
    // Cron: durable scheduled prompts under the LMcode home.
    let cron_handle: lmcode_core::tools::cron::CronHandle = Arc::new(tokio::sync::Mutex::new(
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
    // Subagents: `Agent` (one) and `WolfPack` (parallel over items). The
    // runner snapshots the startup provider and the current tool set.
    let subagent_runner = Arc::new(lmcode_core::subagent::SubagentRunner::new(
        Arc::clone(&provider),
        tools.clone(),
        cwd.clone(),
    ));
    tools.push(Arc::new(lmcode_core::tools::collaboration::AgentTool::new(
        Arc::clone(&subagent_runner),
    )));
    tools.push(Arc::new(
        lmcode_core::tools::collaboration::WolfPackTool::new(Arc::clone(&subagent_runner)),
    ));
    tools.push(Arc::new(AskUserQuestionTool::new()));
    let mut memo_store_for_agent = None;
    match MemoStore::open(&MemoStore::default_path()) {
        Ok(memo_store) => {
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
                session_id,
                embedding_engine.clone(),
            )));
            tools.push(Arc::new(MemoryEditTool::new(Arc::clone(&memo_store))));
            tools.push(Arc::new(MemoryConsolidatePlanTool::new(Arc::clone(
                &memo_store,
            ))));
            tools.push(Arc::new(MemoryConsolidateApplyTool::new(memo_store)));
        }
        Err(error) => ui.error(&format!("memory store unavailable: {error}")),
    }

    // Dream cadence: count this session and suggest /dream when due.
    {
        let mut tracker = lmcode_memory::DreamTracker::load(&lmcode_core::config::lmcode_home());
        tracker.record_session();
        if tracker.should_suggest() {
            ui.info("memory dream is due — run /dream to consolidate the memory store");
        }
        if let Err(error) = tracker.save() {
            ui.error(&format!("failed to save dream tracker: {error}"));
        }
    }

    // MCP servers: spawn/handshake at startup, keep the manager for runtime
    // enable/disable from the TUI `/mcp` panel.
    let (mcp_manager, mcp_tools, mcp_log) =
        lmcode_core::mcp_manager::McpManager::start_all(&cwd).await;
    for (ok, message) in &mcp_log {
        if *ok {
            ui.info(message);
        } else {
            ui.error(message);
        }
    }
    tools.extend(mcp_tools);

    // Skills: explicit `--skills-dir` replaces auto-discovery; otherwise
    // scan project + user directories and expose them to the model.
    let skills = if cli.skills_dirs.is_empty() {
        lmcode_core::skill::discover_skills(&cwd)
    } else {
        lmcode_core::skill::discover_skills_in(&cli.skills_dirs)
    };
    if !skills.is_empty() {
        ui.info(&format!("skills: {} loaded", skills.len()));
        tools.push(Arc::new(SkillTool::new(skills.clone())));
    }
    let system_prompt = if skills.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!(
            "{SYSTEM_PROMPT}\n\n{}",
            lmcode_core::skill::render_skill_prompt(&skills)
        )
    };

    let mut agent = Agent::new(provider, tools, system_prompt, cwd.clone());
    agent.attach_plan(Arc::clone(&plan_handle));
    agent.attach_goal(goal_handle);
    agent.attach_cron(cron_handle);
    agent.attach_evidence_snapshot(evidence_snapshot);
    agent.set_compaction_limits(
        max_context_size.unwrap_or(0),
        max_output_size.unwrap_or(8192),
    );
    agent.attach_session(session);
    if let Some(store) = memo_store_for_agent {
        agent.attach_memo_store(store);
    }

    // `--plan`: start the session in plan mode (plan file created eagerly).
    if cli.plan {
        match plan_handle.lock().await.enter(&cwd, true) {
            Ok(path) => ui.info(&format!("plan mode active — plan file: {}", path.display())),
            Err(error) => ui.error(&format!("failed to enter plan mode: {error}")),
        }
    }

    // Non-interactive one-shot mode.
    if let Some(prompt) = cli.effective_prompt() {
        let turn_result = match cli.output_format.unwrap_or(OutputFormat::Text) {
            OutputFormat::Text => {
                let outcome = agent.run_turn(&prompt, &mut ui).await;
                ui.finish_turn();
                match outcome {
                    Ok(outcome) => {
                        if outcome.interrupted {
                            ui.info("interrupted (history rolled back)");
                        }
                        Ok(())
                    }
                    Err(error) => Err(error.into()),
                }
            }
            OutputFormat::StreamJson => {
                let mut stream_ui = stream_json::StreamJsonUi::new(agent.session_id());
                let outcome = agent.run_turn(&prompt, &mut stream_ui).await;
                match outcome {
                    Ok(outcome) => {
                        stream_ui.finish(outcome.interrupted);
                        Ok(())
                    }
                    Err(error) => Err(error.into()),
                }
            }
        };
        agent.extract_memories_on_exit().await;
        return turn_result;
    }

    // Full-screen TUI (interactive terminals only).
    if cli.tui {
        if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
            let session_id = agent.session_id().map(str::to_string);
            return lmcode_tui::run(agent, display_name.clone(), session_id, mcp_manager).await;
        }
        ui.error("--tui requires an interactive terminal; falling back to the plain REPL");
    }

    ui.banner(&display_name);
    if let Some(id) = agent.session_id() {
        ui.info(&format!("session {id}"));
    }

    loop {
        ui.prompt();
        let line = tokio::select! {
            result = ui::read_line_async() => match result {
                Ok(Some(line)) => line,
                Ok(None) => break, // EOF (Ctrl+Z / piped input exhausted)
                Err(error) => {
                    ui.error(&format!("failed to read input: {error}"));
                    break;
                }
            },
            () = wait_for_ctrl_c() => {
                println!();
                break;
            }
        };

        match line.trim() {
            "" => continue,
            "/exit" | "/quit" => break,
            "/clear" => {
                agent.clear_history();
                ui.info("history cleared");
            }
            "/help" => ui.help(),
            "/sessions" => match session_store.list(&cwd) {
                Ok(sessions) if sessions.is_empty() => {
                    ui.info("no sessions for this directory");
                }
                Ok(sessions) => {
                    ui.info(&format!(
                        "{} session(s) for this directory:",
                        sessions.len()
                    ));
                    for state in sessions.iter().take(10) {
                        let title = state.title.as_deref().unwrap_or("(untitled)");
                        println!("  {}  {}  {title}", state.id, state.updated_at);
                    }
                }
                Err(error) => ui.error(&format!("{error}")),
            },
            input => match agent.run_turn(input, &mut ui).await {
                Ok(outcome) => {
                    ui.finish_turn();
                    if outcome.interrupted {
                        ui.info("interrupted (history rolled back)");
                    } else if outcome.hit_step_limit {
                        ui.info("step limit reached — send another message to continue");
                    }
                }
                Err(error) => {
                    ui.finish_turn();
                    ui.error(&format!("{error}"));
                }
            },
        }
    }

    agent.extract_memories_on_exit().await;
    Ok(())
}
