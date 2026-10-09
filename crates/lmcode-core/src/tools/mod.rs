//! Built-in tools — the Rust seed of `packages/agent-core/src/tools/builtin`.

pub mod ask_user;
pub mod bash;
pub mod collaboration;
pub mod cron;
pub mod edit;
pub mod glob;
pub mod goal;
pub mod grep;
pub mod lsp;
pub mod mcp;
pub mod memory;
pub mod planning;
pub mod read;
pub mod skill;
pub mod task_output;
pub mod web;
pub mod write;

use std::path::{Path, PathBuf};

use async_trait::async_trait;

pub use ask_user::AskUserQuestionTool;
pub use bash::BashTool;
pub use edit::EditTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use mcp::McpToolAdapter;
pub use memory::{
    MemoryConsolidateApplyTool, MemoryConsolidatePlanTool, MemoryEditTool, MemoryLookupTool,
    MemoryWriteTool,
};
pub use read::ReadTool;
pub use skill::SkillTool;
pub use write::WriteTool;

/// Resolve a tool path argument: absolute paths pass through, relative paths
/// join the working directory.
pub(crate) fn resolve_path(path: &str, cwd: &Path) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        cwd.join(candidate)
    }
}

/// A tool the agent can execute.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema of the tool arguments.
    fn parameters_schema(&self) -> serde_json::Value;
    /// Whether the loop must ask the user before executing (default: yes).
    fn requires_approval(&self) -> bool {
        true
    }
    /// Whether the tool only reads state (plan mode prefers these).
    fn read_only(&self) -> bool {
        false
    }
    /// Paths this call will write, declared up front so plan mode can block
    /// writes outside the plan file (mirrors the TS `writeFileAccesses`).
    fn declared_write_paths(&self, _arguments: &serde_json::Value) -> Vec<String> {
        Vec::new()
    }
    /// Execute the tool. `Err` is fed back to the model as a tool-result error.
    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String>;
}
