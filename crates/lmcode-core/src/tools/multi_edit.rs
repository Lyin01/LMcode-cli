//! `MultiEdit` — apply several exact replacements to one file atomically.
//!
//! Edits run in order on the in-memory model view. If any edit fails, the
//! file is left untouched.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::edit::{is_pure_crlf, write_back};
use super::{Tool, resolve_path};

pub struct MultiEditTool;

pub(crate) fn compute_anchor(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(4).fold(String::new(), |mut out, byte| {
        out.push_str(&format!("{byte:02x}"));
        out
    })
}

struct EditSpec {
    old_string: String,
    new_string: String,
    replace_all: bool,
}

fn parse_edits(arguments: &Value) -> Result<Vec<EditSpec>, String> {
    let edits = arguments["edits"]
        .as_array()
        .ok_or("Provide at least one edit.")?;
    if edits.is_empty() {
        return Err("Provide at least one edit.".to_string());
    }
    let mut parsed = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        let old_string = edit["old_string"]
            .as_str()
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("edit #{}: old_string must be a non-empty string", index + 1))?
            .to_string();
        let new_string = edit["new_string"]
            .as_str()
            .ok_or_else(|| format!("edit #{}: missing `new_string`", index + 1))?
            .to_string();
        let replace_all = match edit.get("replace_all") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(format!(
                    "edit #{}: replace_all must be a boolean",
                    index + 1
                ));
            }
        };
        parsed.push(EditSpec {
            old_string,
            new_string,
            replace_all,
        });
    }
    Ok(parsed)
}

fn apply_edits(
    mut content: String,
    edits: &[EditSpec],
    path: &str,
) -> Result<(String, usize), String> {
    let mut total = 0usize;
    for (index, edit) in edits.iter().enumerate() {
        let label = format!("edit #{}", index + 1);
        if edit.old_string == edit.new_string {
            return Err(format!(
                "{label}: old_string and new_string are identical; nothing to change. No edits were applied."
            ));
        }
        let count = content.matches(&edit.old_string).count();
        if count == 0 {
            return Err(format!(
                "{label}: old_string not found in {path}. No edits were applied (the batch is atomic). \
                 Re-read the file and verify the exact text and whitespace; remember each edit operates on the result of the previous one."
            ));
        }
        if !edit.replace_all && count > 1 {
            return Err(format!(
                "{label}: old_string is not unique in {path} (found {count} occurrences). \
                 Add more surrounding context to target one occurrence, or set replace_all=true. No edits were applied (the batch is atomic)."
            ));
        }
        content = if edit.replace_all {
            content.replace(&edit.old_string, &edit.new_string)
        } else {
            content.replacen(&edit.old_string, &edit.new_string, 1)
        };
        total += if edit.replace_all { count } else { 1 };
    }
    Ok((content, total))
}

#[async_trait]
impl Tool for MultiEditTool {
    fn name(&self) -> &str {
        "MultiEdit"
    }

    fn description(&self) -> &str {
        "Apply several exact replacements to one existing file. Edits run in \
         order and the batch is atomic: if any edit fails, nothing is written."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory." },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "description": "Edits applied sequentially in order. The whole batch is atomic.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": { "type": "string", "minLength": 1 },
                            "new_string": { "type": "string" },
                            "replace_all": { "type": "boolean" }
                        },
                        "required": ["old_string", "new_string"]
                    }
                },
                "anchor": { "type": "string", "description": "Content anchor from the most recent Read of this file." }
            },
            "required": ["path", "edits"]
        })
    }

    fn declared_write_paths(&self, arguments: &Value) -> Vec<String> {
        arguments["path"]
            .as_str()
            .map(|path| vec![path.to_string()])
            .unwrap_or_default()
    }

    async fn execute(&self, arguments: &Value, cwd: &Path) -> Result<String, String> {
        let path = arguments["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or("missing `path` argument")?;
        if let Some(message) = crate::permission::sensitive_file_block(path) {
            return Err(message);
        }
        let edits = parse_edits(arguments)?;
        let resolved = resolve_path(path, cwd);
        let raw = match tokio::fs::read_to_string(&resolved).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "{path} does not exist. MultiEdit only edits existing files; use Write to create a new file."
                ));
            }
            Err(error) => return Err(format!("failed to read {path}: {error}")),
        };
        let uses_crlf = is_pure_crlf(&raw);
        let view = raw.replace("\r\n", "\n");
        let edits: Vec<EditSpec> = edits
            .into_iter()
            .map(|e| EditSpec {
                old_string: e.old_string.replace("\r\n", "\n"),
                new_string: e.new_string.replace("\r\n", "\n"),
                replace_all: e.replace_all,
            })
            .collect();
        if let Some(anchor) = arguments.get("anchor").and_then(Value::as_str) {
            let current = compute_anchor(&view);
            if current != anchor {
                return Err(format!(
                    "File has changed since last read. The anchor no longer matches (expected {anchor}, got {current}). Please re-read the file and retry."
                ));
            }
        }
        let (updated, replacements) = apply_edits(view, &edits, path)?;
        write_back(&resolved, &updated, uses_crlf).await?;
        let edit_count = edits.len();
        let edit_word = if edit_count == 1 { "edit" } else { "edits" };
        let replacement_word = if replacements == 1 {
            "replacement"
        } else {
            "replacements"
        };
        Ok(format!(
            "Applied {edit_count} {edit_word} ({replacements} {replacement_word}) to {path}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn write_file(dir: &Path, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        tokio::fs::write(&path, contents).await.unwrap();
        path
    }

    #[tokio::test]
    async fn applies_edits_in_order_and_keeps_the_file_when_a_later_edit_fails() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "one two three").await;
        let tool = MultiEditTool;
        let ok = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "one", "new_string": "1"},
                        {"old_string": "1 two", "new_string": "X"}
                    ]
                }),
                dir.path(),
            )
            .await
            .unwrap();
        assert!(ok.contains("Applied 2 edits (2 replacements)"), "{ok}");
        let stored = tokio::fs::read_to_string(dir.path().join("a.txt"))
            .await
            .unwrap();
        assert_eq!(stored, "X three");

        let before = tokio::fs::read_to_string(dir.path().join("a.txt"))
            .await
            .unwrap();
        let error = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "X", "new_string": "Y"},
                        {"old_string": "missing", "new_string": "Z"}
                    ]
                }),
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(error.contains("edit #2"), "{error}");
        assert!(error.contains("not found"), "{error}");
        let after = tokio::fs::read_to_string(dir.path().join("a.txt"))
            .await
            .unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn rejects_non_unique_and_identical_edits_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "x x").await;
        let tool = MultiEditTool;
        let error = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "x", "new_string": "y"}]
                }),
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(error.contains("not unique"), "{error}");
        assert!(error.contains("found 2 occurrences"), "{error}");
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("a.txt"))
                .await
                .unwrap(),
            "x x"
        );

        let same = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "x x", "new_string": "x x"}]
                }),
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(same.contains("identical"), "{same}");
    }

    #[tokio::test]
    async fn replace_all_anchor_and_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "a a a").await;
        let tool = MultiEditTool;
        let replaced = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "a", "new_string": "b", "replace_all": true}]
                }),
                dir.path(),
            )
            .await
            .unwrap();
        assert!(
            replaced.contains("Applied 1 edit (3 replacements)"),
            "{replaced}"
        );
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("a.txt"))
                .await
                .unwrap(),
            "b b b"
        );

        let current = tokio::fs::read_to_string(dir.path().join("a.txt"))
            .await
            .unwrap();
        let anchor = compute_anchor(&current);
        let mismatch = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "anchor": "deadbeef",
                    "edits": [{"old_string": "b", "new_string": "c", "replace_all": true}]
                }),
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(mismatch.contains("anchor no longer matches"), "{mismatch}");
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("a.txt"))
                .await
                .unwrap(),
            "b b b"
        );

        let matched = tool
            .execute(
                &json!({
                    "path": "a.txt",
                    "anchor": anchor,
                    "edits": [{"old_string": "b b b", "new_string": "done"}]
                }),
                dir.path(),
            )
            .await
            .unwrap();
        assert!(matched.contains("Applied 1 edit"), "{matched}");

        let missing = tool
            .execute(
                &json!({
                    "path": "missing.txt",
                    "edits": [{"old_string": "a", "new_string": "b"}]
                }),
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(missing.contains("does not exist"), "{missing}");
        assert!(missing.contains("Write"), "{missing}");
    }

    #[tokio::test]
    async fn preserves_pure_crlf() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "alpha\r\nbeta\r\n").await;
        let tool = MultiEditTool;
        tool.execute(
            &json!({
                "path": "a.txt",
                "edits": [{"old_string": "beta", "new_string": "gamma"}]
            }),
            dir.path(),
        )
        .await
        .unwrap();
        let stored = tokio::fs::read(dir.path().join("a.txt")).await.unwrap();
        assert_eq!(stored, b"alpha\r\ngamma\r\n");
    }
}
