//! `Edit` tool — exact string replacement with uniqueness checks.
//!
//! Mirrors the observable contract of `packages/agent-core/src/tools/builtin/file/edit.ts`:
//! a missing or non-unique `old_string` fails with a guiding message, and
//! `replace_all` opts into replacing every occurrence. Matching happens on the
//! LF "model view"; pure-CRLF files round-trip with their line endings intact.

use std::path::Path;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;
use super::resolve_path;

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "Edit"
    }

    fn description(&self) -> &str {
        "Replace exact strings in a file. Fails when old_string is missing or \
         not unique (unless replace_all is set). Read the file first."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the text file to edit. Relative paths resolve against the working directory."
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact content to replace from the Read output view, without the line-number prefix. Must be non-empty and unique in the file unless replace_all is set."
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files."
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Set true only when every occurrence of old_string should be replaced."
                }
            },
            "required": ["path", "old_string", "new_string"]
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
        let old_string = arguments["old_string"]
            .as_str()
            .ok_or("missing `old_string` argument")?;
        let new_string = arguments["new_string"]
            .as_str()
            .ok_or("missing `new_string` argument")?;
        let replace_all = arguments["replace_all"].as_bool().unwrap_or(false);

        if old_string.is_empty() {
            return Err("old_string must not be empty".to_string());
        }
        if old_string == new_string {
            return Err(
                "no changes to make: old_string and new_string are exactly the same".to_string(),
            );
        }

        let resolved = resolve_path(path, cwd);
        let raw = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|error| format!("failed to read {}: {error}", resolved.display()))?;

        let uses_crlf = is_pure_crlf(&raw);
        let view = if uses_crlf {
            raw.replace("\r\n", "\n")
        } else {
            raw
        };

        let occurrences = view.matches(old_string).count();
        if occurrences == 0 {
            return Err(not_found_message(path));
        }

        let (new_view, message) = if replace_all {
            (
                view.replace(old_string, new_string),
                format!("Replaced {occurrences} occurrences in {path}"),
            )
        } else {
            if occurrences > 1 {
                return Err(format!(
                    "old_string is not unique in {path} (found {occurrences} occurrences). \
                     To replace every occurrence, set replace_all=true. To replace only one \
                     occurrence, include more surrounding context in old_string."
                ));
            }
            (
                view.replacen(old_string, new_string, 1),
                format!("Replaced 1 occurrence in {path}"),
            )
        };

        write_back(&resolved, &new_view, uses_crlf).await?;
        Ok(message)
    }
}

fn not_found_message(path: &str) -> String {
    format!(
        "old_string not found in {path}. The file contents may be out of date. \
         Please use the Read Tool to reload the content."
    )
}

/// A file is treated as pure CRLF only when every `\n` belongs to a `\r\n`
/// pair; mixed endings are left untouched on write-back.
pub(crate) fn is_pure_crlf(raw: &str) -> bool {
    let crlf = raw.matches("\r\n").count();
    let total_lf = raw.matches('\n').count();
    crlf > 0 && crlf == total_lf
}

pub(crate) async fn write_back(path: &Path, view: &str, uses_crlf: bool) -> Result<(), String> {
    let content = if uses_crlf {
        view.replace('\n', "\r\n")
    } else {
        view.to_string()
    };
    tokio::fs::write(path, content)
        .await
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}
