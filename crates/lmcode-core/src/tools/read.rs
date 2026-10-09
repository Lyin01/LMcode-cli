//! `Read` tool — read a file and return its content with line numbers.

use std::path::Path;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;
use super::resolve_path;

const DEFAULT_LIMIT: u64 = 2000;
const MAX_LIMIT: u64 = 5000;
const MAX_LINE_CHARS: usize = 2000;

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }

    fn description(&self) -> &str {
        "Read a file from the local filesystem. Returns the content with line numbers."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path (absolute, or relative to the working directory)"
                },
                "offset": {
                    "type": "integer",
                    "description": "1-based line number to start reading from (default 1)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of lines to read (default 2000, max 5000)"
                }
            },
            "required": ["path"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String> {
        let path = arguments["path"]
            .as_str()
            .ok_or("missing `path` argument")?;
        let resolved = resolve_path(path, cwd);
        let text = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|error| format!("failed to read `{}`: {error}", resolved.display()))?;

        let offset = arguments["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = arguments["limit"]
            .as_u64()
            .unwrap_or(DEFAULT_LIMIT)
            .min(MAX_LIMIT) as usize;
        Ok(render_numbered(&text, offset, limit))
    }
}

/// Numbered file view shared by Read and ReadGroup.
/// `offset` is the 1-based first line. `limit` is the maximum line count.
pub(crate) fn render_numbered(text: &str, offset: usize, limit: usize) -> String {
    let total_lines = text.lines().count();
    let mut output = String::new();
    let mut emitted = 0usize;
    for (index, line) in text.lines().enumerate() {
        let line_number = index + 1;
        if line_number < offset {
            continue;
        }
        if emitted >= limit {
            output.push_str(&format!(
                "... (truncated: showing {emitted} of {total_lines} lines)\n"
            ));
            break;
        }
        let rendered: String = line.chars().take(MAX_LINE_CHARS).collect();
        output.push_str(&format!("{line_number}\t{rendered}\n"));
        emitted += 1;
    }
    if output.is_empty() {
        output.push_str("(file is empty)\n");
    }
    output
}
