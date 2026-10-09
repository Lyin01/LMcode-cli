//! `Write` tool — create, overwrite, or append to a file.
//!
//! Creates missing parent directories so a write to a brand-new path succeeds
//! in a single call (mirrors `packages/agent-core/src/tools/builtin/file/write.ts`).

use std::path::Path;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;
use super::resolve_path;

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "Write"
    }

    fn description(&self) -> &str {
        "Write to a file: create it, append to it, or completely overwrite it. \
         Missing parent directories are created automatically — do not mkdir first."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically — do not mkdir first."
                },
                "content": {
                    "type": "string",
                    "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view."
                },
                "mode": {
                    "type": "string",
                    "enum": ["overwrite", "append"],
                    "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline."
                }
            },
            "required": ["path", "content"]
        })
    }

    fn declared_write_paths(&self, arguments: &serde_json::Value) -> Vec<String> {
        arguments["path"]
            .as_str()
            .map(|path| vec![path.to_string()])
            .unwrap_or_default()
    }

    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String> {
        let path = arguments["path"]
            .as_str()
            .ok_or("missing `path` argument")?;
        let content = arguments["content"]
            .as_str()
            .ok_or("missing `content` argument")?;
        let mode = arguments["mode"].as_str().unwrap_or("overwrite");
        if mode != "overwrite" && mode != "append" {
            return Err(format!(
                "invalid `mode` {mode:?}: expected \"overwrite\" or \"append\""
            ));
        }
        let resolved = resolve_path(path, cwd);

        // Create missing parent directories so a single call can write to a
        // brand-new path; a non-directory parent is unfixable and reported.
        if let Some(parent) = resolved.parent()
            && !parent.as_os_str().is_empty()
        {
            match tokio::fs::metadata(parent).await {
                Ok(metadata) if !metadata.is_dir() => {
                    return Err(format!(
                        "parent path is not a directory: {}",
                        parent.display()
                    ));
                }
                Ok(_) => {}
                Err(_) => {
                    tokio::fs::create_dir_all(parent).await.map_err(|error| {
                        format!(
                            "failed to create parent directory {}: {error}",
                            parent.display()
                        )
                    })?;
                }
            }
        }

        let bytes_written = content.len();
        match mode {
            "append" => {
                use tokio::io::AsyncWriteExt;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&resolved)
                    .await
                    .map_err(|error| format!("failed to open {}: {error}", resolved.display()))?;
                file.write_all(content.as_bytes())
                    .await
                    .map_err(|error| format!("failed to write {}: {error}", resolved.display()))?;
                Ok(format!("Appended {bytes_written} bytes to {path}"))
            }
            _ => {
                tokio::fs::write(&resolved, content)
                    .await
                    .map_err(|error| format!("failed to write {}: {error}", resolved.display()))?;
                Ok(format!("Wrote {bytes_written} bytes to {path}"))
            }
        }
    }
}
