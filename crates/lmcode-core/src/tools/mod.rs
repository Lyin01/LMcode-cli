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
pub mod multi_edit;
pub mod planning;
pub mod read;
pub mod read_group;
pub mod read_media;
pub mod skill;
pub mod task_list;
pub mod task_output;
pub mod task_stop;
pub mod todo;
pub mod web;
pub mod write;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use lmcode_llm::message::ContentPart;

use crate::permission::{FileAccess, FileOperation};

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
pub use multi_edit::MultiEditTool;
pub use read::ReadTool;
pub use read_group::ReadGroupTool;
pub use read_media::ReadMediaFileTool;
pub use skill::SkillTool;
pub use task_list::TaskListTool;
pub use task_stop::TaskStopTool;
pub use todo::{TodoList, TodoListTool};
pub use write::WriteTool;

pub(crate) fn path_access(
    arguments: &serde_json::Value,
    key: &str,
    operation: FileOperation,
) -> Vec<FileAccess> {
    arguments
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.is_empty())
        .map(|path| vec![FileAccess::new(path, operation)])
        .unwrap_or_default()
}

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
    /// File accesses the permission chain sees. Defaults to the write paths.
    fn declared_file_accesses(&self, arguments: &serde_json::Value) -> Vec<FileAccess> {
        self.declared_write_paths(arguments)
            .into_iter()
            .map(|path| FileAccess::new(path, FileOperation::Write))
            .collect()
    }
    /// Bash and WolfPack declare no path, so a workspace-write sandbox cannot
    /// prove they stay inside the cwd.
    fn unrestricted(&self) -> bool {
        false
    }
    /// Current todo rows, when this tool owns the session list.
    fn todo_items(&self) -> Option<Vec<todo::TodoItem>> {
        None
    }
    /// Execute the tool. `Err` is fed back to the model as a tool-result error.
    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String>;

    /// Rich result used by the turn loop. The default wraps [`Tool::execute`].
    /// Override this when the result carries image or video parts, or when a
    /// failure still has a body the model should read (`ok` is false).
    async fn execute_rich(
        &self,
        arguments: &serde_json::Value,
        cwd: &Path,
    ) -> Result<ToolResult, String> {
        match self.execute(arguments, cwd).await {
            Ok(text) => Ok(ToolResult::success(text)),
            Err(message) => Ok(ToolResult::failure(format!("error: {message}"))),
        }
    }
}

/// What a tool returns to the turn loop.
pub struct ToolResult {
    /// Text shown in the UI and stored as the text parts of `content`.
    pub text: String,
    /// False when the call failed. The model still receives `text`.
    pub ok: bool,
    /// Parts written onto the tool-result message. Includes images.
    pub content: Vec<ContentPart>,
}

impl ToolResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self::from_text(text, true)
    }

    pub fn failure(text: impl Into<String>) -> Self {
        Self::from_text(text, false)
    }

    pub fn reported(text: impl Into<String>, ok: bool) -> Self {
        Self::from_text(text, ok)
    }

    pub fn parts(content: Vec<ContentPart>, ok: bool) -> Self {
        let text = content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        Self { text, ok, content }
    }

    fn from_text(text: impl Into<String>, ok: bool) -> Self {
        let text = text.into();
        Self {
            content: vec![ContentPart::Text { text: text.clone() }],
            text,
            ok,
        }
    }
}
