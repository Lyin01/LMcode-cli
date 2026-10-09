//! `Glob` tool — file pattern matching, sorted by modification time.
//!
//! Native implementation via `globset` + `ignore`; mirrors the observable
//! contract of `file/glob.ts`: mtime-descending order, paths displayed
//! relative to the search root, and a refusal to enumerate pure-wildcard
//! patterns that have no literal anchor.

use std::path::Path;
use std::time::SystemTime;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;
use super::resolve_path;

const MAX_MATCHES: usize = 1000;
/// Secondary cap on raw walk results, guarding runaway trees.
const YIELD_SAFETY_CAP: usize = MAX_MATCHES * 2;

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "Glob"
    }

    fn description(&self) -> &str {
        "Find files and directories by glob pattern, sorted by modification time \
         (most recent first). Patterns need a literal anchor (an extension, \
         directory, or filename); pure wildcards like `**` are rejected."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match files/directories, e.g. `src/**/*.ts`. Brace alternates like `*.{ts,tsx}` are supported."
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (absolute, or relative to the working directory). Defaults to the working directory."
                },
                "include_dirs": {
                    "type": "boolean",
                    "description": "Whether to include directories in results. Defaults to true. Set false to return only files."
                }
            },
            "required": ["pattern"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    fn declared_file_accesses(
        &self,
        arguments: &serde_json::Value,
    ) -> Vec<crate::permission::FileAccess> {
        super::path_access(arguments, "path", crate::permission::FileOperation::Search)
    }

    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String> {
        let pattern = arguments["pattern"]
            .as_str()
            .ok_or("missing `pattern` argument")?
            .to_string();
        let root = match arguments["path"].as_str() {
            Some(path) => resolve_path(path, cwd),
            None => cwd.to_path_buf(),
        };
        let include_dirs = arguments["include_dirs"].as_bool().unwrap_or(true);

        if !has_literal_anchor(&pattern) {
            return Err(format!(
                "pattern {pattern:?} has no literal anchor (only wildcards). Add a literal \
                 part — an extension, a directory, or a filename — so the search is bounded."
            ));
        }

        let matcher = globset::Glob::new(&pattern)
            .map_err(|error| format!("invalid glob pattern {pattern:?}: {error}"))?
            .compile_matcher();

        tokio::task::spawn_blocking(move || run_glob(&matcher, &root, include_dirs, &pattern))
            .await
            .map_err(|join_error| format!("glob task failed: {join_error}"))?
    }
}

/// A pattern is bounded when it contains at least one character that is not a
/// wildcard or separator (`**`, `**/*`, `*/*` are rejected; `*.ts` is fine).
fn has_literal_anchor(pattern: &str) -> bool {
    pattern
        .chars()
        .any(|character| !matches!(character, '*' | '?' | '/'))
}

fn run_glob(
    matcher: &globset::GlobMatcher,
    root: &Path,
    include_dirs: bool,
    pattern: &str,
) -> Result<String, String> {
    if !root.exists() {
        return Err(format!("{} does not exist", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }

    let mut entries: Vec<(SystemTime, String)> = Vec::new();
    let mut truncated = false;

    let walker = build_walker(root);
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path == root {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !include_dirs && is_dir {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if !matcher.is_match(&relative) {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        entries.push((mtime, relative));
        if entries.len() >= YIELD_SAFETY_CAP {
            truncated = true;
            break;
        }
    }

    entries.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let total = entries.len();
    let capped: Vec<String> = entries
        .into_iter()
        .take(MAX_MATCHES)
        .map(|(_, relative)| relative)
        .collect();

    if capped.is_empty() {
        return Ok(format!("No files found matching `{pattern}`"));
    }

    let mut lines = capped;
    if truncated || total > MAX_MATCHES {
        lines.push(format!("... (truncated at {MAX_MATCHES} matches)"));
    } else {
        lines.push(format!("Found {total} matches"));
    }
    Ok(lines.join("\n"))
}

fn build_walker(root: &Path) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|entry| {
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy();
                !matches!(name.as_ref(), ".git" | ".hg" | ".svn")
            } else {
                true
            }
        });
    builder.build()
}
