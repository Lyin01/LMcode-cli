//! `Grep` tool — regex content search on a native Rust engine.
//!
//! Uses the `ignore` + `regex` crates (the same components ripgrep is built
//! on) instead of shelling out, keeping the CLI a self-contained binary.
//! Mirrors the observable contract of `file/grep.ts`: output modes, pagination
//! via `head_limit` / `offset`, case-insensitivity, and context lines.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::json;

use super::Tool;
use super::resolve_path;

const DEFAULT_HEAD_LIMIT: u64 = 250;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 500;

pub struct GrepTool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Content,
    FilesWithMatches,
    CountMatches,
}

impl OutputMode {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "content" => Ok(Self::Content),
            "files_with_matches" => Ok(Self::FilesWithMatches),
            "count_matches" => Ok(Self::CountMatches),
            other => Err(format!(
                "invalid `output_mode` {other:?}: expected \"content\", \
                 \"files_with_matches\", or \"count_matches\""
            )),
        }
    }
}

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
    }

    fn description(&self) -> &str {
        "Search file contents with a regular expression (Rust regex syntax). \
         Returns matching files by default; use output_mode=\"content\" for matching lines."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regular expression to search for."
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search (absolute, or relative to the working directory). Omit to search the working directory."
                },
                "glob": {
                    "type": "string",
                    "description": "Optional glob filter for candidate files (e.g. `*.ts` or `src/**`)."
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count_matches"],
                    "description": "Shape of the result. `content` shows matching lines; `files_with_matches` shows only file paths; `count_matches` shows per-file match counts. Defaults to `files_with_matches`."
                },
                "-i": {
                    "type": "boolean",
                    "description": "Perform a case-insensitive search. Defaults to false."
                },
                "-n": {
                    "type": "boolean",
                    "description": "Prefix each matching line with its line number (content mode). Defaults to true."
                },
                "-A": {
                    "type": "integer",
                    "description": "Number of lines to show after each match (content mode)."
                },
                "-B": {
                    "type": "integer",
                    "description": "Number of lines to show before each match (content mode)."
                },
                "-C": {
                    "type": "integer",
                    "description": "Lines before and after each match (content mode; takes precedence over -A/-B)."
                },
                "head_limit": {
                    "type": "integer",
                    "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited."
                },
                "offset": {
                    "type": "integer",
                    "description": "Entries to skip before applying head_limit (pagination). Defaults to 0."
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
        let glob = arguments["glob"].as_str().map(str::to_string);
        let output_mode = OutputMode::parse(
            arguments["output_mode"]
                .as_str()
                .unwrap_or("files_with_matches"),
        )?;
        let case_insensitive = arguments["-i"].as_bool().unwrap_or(false);
        let line_numbers = arguments["-n"].as_bool().unwrap_or(true);
        let context = arguments["-C"].as_u64().unwrap_or(0) as usize;
        let (before, after) = if context > 0 {
            (context, context)
        } else {
            (
                arguments["-B"].as_u64().unwrap_or(0) as usize,
                arguments["-A"].as_u64().unwrap_or(0) as usize,
            )
        };
        let head_limit = arguments["head_limit"]
            .as_u64()
            .unwrap_or(DEFAULT_HEAD_LIMIT) as usize;
        let offset = arguments["offset"].as_u64().unwrap_or(0) as usize;

        let options = SearchOptions {
            pattern,
            root,
            glob,
            output_mode,
            case_insensitive,
            line_numbers,
            before,
            after,
            head_limit,
            offset,
        };
        tokio::task::spawn_blocking(move || run_search(options))
            .await
            .map_err(|join_error| format!("search task failed: {join_error}"))?
    }
}

struct SearchOptions {
    pattern: String,
    root: PathBuf,
    glob: Option<String>,
    output_mode: OutputMode,
    case_insensitive: bool,
    line_numbers: bool,
    before: usize,
    after: usize,
    head_limit: usize,
    offset: usize,
}

fn run_search(options: SearchOptions) -> Result<String, String> {
    let regex = RegexBuilder::new(&options.pattern)
        .case_insensitive(options.case_insensitive)
        .build()
        .map_err(|error| format!("invalid regex pattern: {error}"))?;

    let glob_matcher = match &options.glob {
        Some(pattern) => Some(
            globset::Glob::new(pattern)
                .map_err(|error| format!("invalid glob filter {pattern:?}: {error}"))?
                .compile_matcher(),
        ),
        None => None,
    };

    // (sort key, rendered output line); sorted for stable, testable output.
    let mut collected: Vec<((String, usize), String)> = Vec::new();

    let walker = build_walker(&options.root);
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry
            .file_type()
            .map(|file_type| file_type.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let path = entry.path();
        let relative = display_path(path, &options.root);
        if let Some(matcher) = &glob_matcher
            && !matcher.is_match(relative.replace('\\', "/"))
        {
            continue;
        }
        if entry
            .metadata()
            .map(|metadata| metadata.len() > MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if content.contains('\0') {
            continue; // skip binary files
        }

        match options.output_mode {
            OutputMode::FilesWithMatches => {
                if regex.is_match(&content) {
                    collected.push(((relative.clone(), 0), relative));
                }
            }
            OutputMode::CountMatches => {
                let count = regex.find_iter(&content).count();
                if count > 0 {
                    collected.push(((relative.clone(), 0), format!("{relative}:{count}")));
                }
            }
            OutputMode::Content => {
                collect_content_lines(&regex, &content, &relative, &options, &mut collected);
            }
        }
    }

    collected.sort_by(|a, b| a.0.cmp(&b.0));
    let total = collected.len();
    let page: Vec<String> = collected
        .into_iter()
        .skip(options.offset)
        .take(if options.head_limit == 0 {
            usize::MAX
        } else {
            options.head_limit
        })
        .map(|(_, line)| line)
        .collect();

    if page.is_empty() {
        return Ok(format!(
            "No matches found for pattern `{}`.",
            options.pattern
        ));
    }

    let mut result = page.join("\n");
    if options.head_limit > 0 && total > options.offset + options.head_limit {
        let next_offset = options.offset + options.head_limit;
        result.push_str(&format!(
            "\n\nResults truncated to {} lines (total: {}). Use offset={next_offset} to see more.",
            options.head_limit, total
        ));
    }
    Ok(result)
}

fn collect_content_lines(
    regex: &regex::Regex,
    content: &str,
    relative: &str,
    options: &SearchOptions,
    collected: &mut Vec<((String, usize), String)>,
) {
    let lines: Vec<&str> = content.lines().collect();
    let match_indices: BTreeSet<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| regex.is_match(line))
        .map(|(index, _)| index)
        .collect();
    if match_indices.is_empty() {
        return;
    }

    // Merge per-match context windows so overlapping ranges print once.
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &index in &match_indices {
        let start = index.saturating_sub(options.before);
        let end = (index + options.after).min(lines.len() - 1);
        match ranges.last_mut() {
            Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
            _ => ranges.push((start, end)),
        }
    }

    for (start, end) in ranges {
        for (index, line) in lines.iter().enumerate().take(end + 1).skip(start) {
            let line: String = line.chars().take(MAX_LINE_CHARS).collect();
            let rendered = if options.line_numbers {
                format!("{relative}:{}:{line}", index + 1)
            } else {
                format!("{relative}:{line}")
            };
            collected.push(((relative.to_string(), index + 1), rendered));
        }
    }
}

/// Build a walker that searches hidden files but respects ignore files and
/// skips VCS metadata plus common sensitive files.
fn build_walker(root: &Path) -> ignore::Walk {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                !matches!(
                    name.as_ref(),
                    ".git" | ".hg" | ".svn" | "node_modules" | "target"
                )
            } else {
                !crate::permission::is_sensitive_path(&name)
            }
        });
    builder.build()
}

fn display_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
