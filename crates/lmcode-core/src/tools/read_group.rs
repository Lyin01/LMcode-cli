//! `ReadGroup` — read up to 10 files and return one section per path.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::read::render_numbered;
use super::{Tool, ToolResult, resolve_path};

const MAX_FILES: usize = 10;
const MAX_LINES: usize = 1000;

pub struct ReadGroupTool;

fn read_window(text: &str, line_offset: i64, n_lines: usize) -> String {
    let total = text.lines().count() as i64;
    let start = if line_offset < 0 {
        (total + line_offset + 1).max(1) as usize
    } else {
        line_offset.max(1) as usize
    };
    render_numbered(text, start, n_lines.min(MAX_LINES))
}

#[async_trait]
impl Tool for ReadGroupTool {
    fn name(&self) -> &str {
        "ReadGroup"
    }

    fn description(&self) -> &str {
        "Read 1-10 text files in one call. Each file is returned under a \
         `--- path ---` header. A file that cannot be read is marked [ERROR] \
         and the whole call is a failure, while the other files are still shown."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_FILES,
                    "items": { "type": "string", "minLength": 1 },
                    "description": "Array of file paths to read (1-10 files)."
                },
                "line_offset": {
                    "type": "integer",
                    "description": "Starting line applied to every file. Negative values read from the end."
                },
                "n_lines": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Maximum lines per file."
                }
            },
            "required": ["paths"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    fn declared_file_accesses(&self, arguments: &Value) -> Vec<crate::permission::FileAccess> {
        arguments["paths"]
            .as_array()
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|path| path.as_str())
                    .filter(|path| !path.is_empty())
                    .map(|path| {
                        crate::permission::FileAccess::new(
                            path,
                            crate::permission::FileOperation::Read,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn execute(&self, arguments: &Value, cwd: &Path) -> Result<String, String> {
        let result = self.execute_rich(arguments, cwd).await?;
        if result.ok {
            Ok(result.text)
        } else {
            Err(result.text)
        }
    }

    async fn execute_rich(&self, arguments: &Value, cwd: &Path) -> Result<ToolResult, String> {
        let paths = arguments["paths"]
            .as_array()
            .ok_or("ReadGroup requires a paths array")?;
        if paths.is_empty() || paths.len() > MAX_FILES {
            return Err(format!("ReadGroup accepts 1-{MAX_FILES} paths"));
        }
        let line_offset = arguments
            .get("line_offset")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        if line_offset == 0 || line_offset < -(MAX_LINES as i64) {
            return Err(format!(
                "line_offset must be >= 1 or between -{MAX_LINES} and -1"
            ));
        }
        let n_lines = match arguments.get("n_lines") {
            None => MAX_LINES,
            Some(Value::Number(number)) => {
                let lines = number
                    .as_u64()
                    .filter(|lines| *lines >= 1)
                    .ok_or("n_lines must be a positive integer")?
                    as usize;
                lines.min(MAX_LINES)
            }
            Some(_) => return Err("n_lines must be a positive integer".to_string()),
        };

        let mut sections = Vec::new();
        let mut has_error = false;
        for (index, path_value) in paths.iter().enumerate() {
            let path = path_value
                .as_str()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| format!("path {} must be a non-empty string", index + 1))?;
            if index > 0 {
                sections.push(String::new());
            }
            sections.push(format!("--- {path} ---"));
            if let Some(message) = crate::permission::sensitive_file_block(path) {
                has_error = true;
                sections.push(format!("[ERROR] {message}"));
                continue;
            }
            let resolved = resolve_path(path, cwd);
            match tokio::fs::read_to_string(&resolved).await {
                Ok(text) => sections.push(read_window(&text, line_offset, n_lines)),
                Err(error) => {
                    has_error = true;
                    sections.push(format!("[ERROR] failed to read `{path}`: {error}"));
                }
            }
        }
        Ok(ToolResult::reported(sections.join("\n"), !has_error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_several_files_and_marks_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("a.txt"), "alpha\nbeta\n")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("b.txt"), "only\n")
            .await
            .unwrap();
        let tool = ReadGroupTool;
        let result = tool
            .execute_rich(
                &json!({"paths": ["a.txt", "missing.txt", "b.txt"], "n_lines": 10}),
                dir.path(),
            )
            .await
            .unwrap();
        assert!(!result.ok);
        assert!(result.text.contains("--- a.txt ---"), "{}", result.text);
        assert!(result.text.contains("1\talpha"), "{}", result.text);
        assert!(result.text.contains("[ERROR]"), "{}", result.text);
        assert!(result.text.contains("--- b.txt ---"), "{}", result.text);
        assert!(result.text.contains("1\tonly"), "{}", result.text);
    }

    #[tokio::test]
    async fn negative_offset_reads_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n")
            .await
            .unwrap();
        let tool = ReadGroupTool;
        let result = tool
            .execute_rich(
                &json!({"paths": ["a.txt"], "line_offset": -1, "n_lines": 5}),
                dir.path(),
            )
            .await
            .unwrap();
        assert!(result.ok);
        assert!(result.text.contains("3\tthree"), "{}", result.text);
        assert!(!result.text.contains("1\tone"), "{}", result.text);
    }
}
