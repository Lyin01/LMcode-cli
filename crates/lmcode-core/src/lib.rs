//! LMcode agent runtime — Rust port of `packages/agent-core`.
//!
//! Covers: configuration loading, model resolution, the turn loop with tool
//! dispatch, the built-in tool set (Read/Write/Edit/Bash/Grep/Glob/memory/
//! skill/MCP adapters), session persistence, the compaction pipeline (micro
//! projection + full summarization), permission policies, the MCP runtime
//! manager, and session usage accounting.

pub mod agent;
pub mod background;
pub mod compaction;
pub mod computer_use;
pub mod config;
pub mod cron;
pub mod cron_expr;
pub mod error;
pub mod goal;
pub mod grader;
pub mod injection;
pub mod lsp;
pub mod mcp_manager;
pub mod permission;
pub mod permission_chain;
pub mod plan;
pub mod retry;
pub mod session;
pub mod session_memory;
pub mod skill;
pub mod subagent;
pub mod tools;
pub mod usage;

pub use agent::{Agent, TurnOutcome, TurnUi};
pub use error::CoreError;
pub use permission::SessionApprovals;
pub use session::{Session, SessionState, SessionStore};
pub use skill::{SkillDefinition, discover_skills, render_skill_prompt};
