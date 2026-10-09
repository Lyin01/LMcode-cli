//! `LSP` tool — read-only code intelligence via language servers
//! (mirrors `tools/builtin/lsp-tool.ts`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::lsp::{LspLocation, LspRegistry};

use super::Tool;

/// Query a language server for references, definitions, and diagnostics.
pub struct LspTool {
    registry: Arc<LspRegistry>,
}

impl LspTool {
    pub fn new(registry: Arc<LspRegistry>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        "LSP"
    }

    fn description(&self) -> &str {
        "Query a language server for read-only code intelligence. Use 'references' to find all \
         usages of a symbol, 'definition' to jump to where a symbol is defined, and 'diagnostics' \
         to get type errors and warnings for a file. The language server is started automatically \
         for supported file types (TypeScript/JavaScript, Python, Rust, Go). This tool does not \
         edit files; use the results to inform Read/Edit operations."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the source file. Relative paths resolve against the working directory."
                },
                "operation": {
                    "type": "string",
                    "description": "LSP operation: 'references', 'definition', or 'diagnostics'."
                },
                "line": {
                    "type": "integer",
                    "description": "1-based line number for references/definition."
                },
                "character": {
                    "type": "integer",
                    "description": "0-based column offset for references/definition."
                },
                "include_declaration": {
                    "type": "boolean",
                    "description": "For 'references': include the declaration site in the results."
                }
            },
            "required": ["path", "operation"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, cwd: &Path) -> Result<String, String> {
        let path_arg = arguments["path"]
            .as_str()
            .ok_or("missing `path` argument")?;
        let operation = arguments["operation"]
            .as_str()
            .ok_or("missing `operation` argument")?;
        let path: PathBuf = if Path::new(path_arg).is_absolute() {
            PathBuf::from(path_arg)
        } else {
            cwd.join(path_arg)
        };
        let Some(client) = self
            .registry
            .get_client(&path.to_string_lossy(), cwd)
            .await?
        else {
            return Err(format!(
                "No language server configured for {path_arg}. Supported file extensions: .ts, \
                 .tsx, .js, .jsx, .py, .rs, .go."
            ));
        };
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {path_arg}: {error}"))?;
        let mut client = client.lock().await;
        client
            .did_open(&path, &content)
            .await
            .map_err(|error| format!("LSP request failed: {error}"))?;

        match operation {
            "references" => {
                let (line, character) = position(arguments, "references")?;
                let include = arguments["include_declaration"].as_bool().unwrap_or(false);
                let locations = client
                    .references(&path, line, character, include)
                    .await
                    .map_err(|error| format!("LSP request failed: {error}"))?;
                Ok(format_locations("reference", &locations))
            }
            "definition" => {
                let (line, character) = position(arguments, "definition")?;
                let locations = client
                    .definition(&path, line, character)
                    .await
                    .map_err(|error| format!("LSP request failed: {error}"))?;
                Ok(format_locations("definition", &locations))
            }
            "diagnostics" => {
                let diagnostics = client
                    .diagnostics(&path)
                    .await
                    .map_err(|error| format!("LSP request failed: {error}"))?;
                if diagnostics.is_empty() {
                    return Ok("No diagnostics for this file.".to_string());
                }
                let mut output = format!("{} diagnostic(s):\n", diagnostics.len());
                for diagnostic in &diagnostics {
                    output.push_str(&format!(
                        "\n{}:{}:{} {}: {}",
                        path_arg,
                        diagnostic.line + 1,
                        diagnostic.character + 1,
                        diagnostic.severity,
                        diagnostic.message
                    ));
                }
                Ok(output)
            }
            other => Err(format!("Unsupported operation: {other}")),
        }
    }
}

/// Extract the 1-based line (converted to 0-based) and character arguments.
fn position(arguments: &Value, operation: &str) -> Result<(u64, u64), String> {
    let line = arguments["line"]
        .as_u64()
        .ok_or_else(|| format!("'{operation}' requires both 'line' and 'character'."))?;
    let character = arguments["character"]
        .as_u64()
        .ok_or_else(|| format!("'{operation}' requires both 'line' and 'character'."))?;
    Ok((line.saturating_sub(1), character))
}

fn format_locations(kind: &str, locations: &[LspLocation]) -> String {
    if locations.is_empty() {
        return format!("No {kind} found.");
    }
    let mut output = format!("Found {} {kind}(s):\n", locations.len());
    for location in locations {
        output.push_str(&format!(
            "\n{}:{}:{}",
            location.path,
            location.line + 1,
            location.character + 1
        ));
    }
    output
}
