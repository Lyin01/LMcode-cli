//! Memory tools — `MemoryLookup` and `MemoryWrite` — backed by `lmcode-memory`.
//!
//! Mirrors the observable contract of `tools/builtin/memory/*.ts`: the same
//! parameter names, defaults, and output formats.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use lmcode_memory::{
    ConsolidationPlan, EmbeddingEngine, MemoKind, MemoStore, ScoredMemo, build_embedding_text,
    cosine_similarity, generate_tags, normalize_tags, rank_memos,
};
use serde_json::json;

use super::Tool;

const DEFAULT_LIMIT: u64 = 5;
const MAX_LIMIT: u64 = 20;
const DEFAULT_MIN_SCORE: f64 = 0.2;

/// Working directories are stored in forward-slash form.
fn normalized_dir(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// `MemoryLookup` — ranked search over stored task experiences.
pub struct MemoryLookupTool {
    store: Arc<MemoStore>,
    cwd: PathBuf,
    engine: Option<Arc<dyn EmbeddingEngine>>,
}

impl MemoryLookupTool {
    pub fn new(
        store: Arc<MemoStore>,
        cwd: PathBuf,
        engine: Option<Arc<dyn EmbeddingEngine>>,
    ) -> Self {
        Self { store, cwd, engine }
    }
}

#[async_trait]
impl Tool for MemoryLookupTool {
    fn name(&self) -> &str {
        "MemoryLookup"
    }

    fn description(&self) -> &str {
        "Search the memory memo store for historical experiences from past user tasks. \
         Call this when the current task may benefit from prior work, when you encounter a \
         repeating error or pattern, or when you are unsure of the best approach. \
         Returns memos ranked by relevance, including the approach taken, the outcome, \
         what failed, what worked, project, and tags. By default searches globally; \
         use scope: project to restrict results to the current project."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query describing the current task, error, approach, or keywords to look up in the memory memo store."
                },
                "limit": {
                    "type": "integer",
                    "description": format!("Maximum number of memos to return (default {DEFAULT_LIMIT}, max {MAX_LIMIT}).")
                },
                "min_score": {
                    "type": "number",
                    "description": format!("Minimum relevance score threshold from 0 to 1 (default {DEFAULT_MIN_SCORE}).")
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "global"],
                    "description": "Search scope: 'global' (default) searches across all projects; 'project' limits results to the current working directory."
                }
            },
            "required": ["query"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(&self, arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let query = arguments["query"]
            .as_str()
            .ok_or("missing `query` argument")?
            .trim()
            .to_string();
        if query.is_empty() {
            return Err("query cannot be empty".to_string());
        }
        let limit = arguments["limit"]
            .as_u64()
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, MAX_LIMIT) as usize;
        let min_score = arguments["min_score"]
            .as_f64()
            .unwrap_or(DEFAULT_MIN_SCORE)
            .clamp(0.0, 1.0);
        let scope = arguments["scope"].as_str().unwrap_or("global").to_string();
        let current_dir = normalized_dir(&self.cwd);

        // Query embedding when an engine is available; any failure degrades
        // to pure rule scoring.
        let query_vector: Option<Vec<f32>> = match &self.engine {
            Some(engine) if engine.available() => engine
                .embed(std::slice::from_ref(&query))
                .await
                .and_then(|mut vectors| vectors.pop()),
            _ => None,
        };
        let model = self
            .engine
            .as_ref()
            .map(|engine| engine.model().to_string());

        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let memos = store.all().map_err(|error| error.to_string())?;
            let total = memos.len();
            let candidates: Vec<_> = if scope == "project" {
                memos
                    .into_iter()
                    .filter(|memo| memo.project_dir == current_dir)
                    .collect()
            } else {
                memos
            };

            let vector_scores: Option<HashMap<String, f32>> = match (&query_vector, &model) {
                (Some(query_vector), Some(model)) => {
                    let stored = store
                        .load_embeddings(model)
                        .map_err(|error| error.to_string())?;
                    let mut scores = HashMap::new();
                    for (id, vector) in stored {
                        scores.insert(id, cosine_similarity(query_vector, &vector) as f32);
                    }
                    Some(scores)
                }
                _ => None,
            };

            let ranked = rank_memos(
                &candidates,
                &query,
                min_score,
                limit,
                Some(&current_dir),
                vector_scores.as_ref(),
            );
            if ranked.is_empty() {
                if total == 0 {
                    return Ok("No memory memos found. The experience store is empty.".to_string());
                }
                return Ok(format!(
                    "No relevant memory memos found for query \"{query}\"."
                ));
            }
            Ok(format_ranked(&query, &ranked))
        })
        .await
        .map_err(|error| format!("memory lookup task failed: {error}"))?
    }
}

fn format_ranked(query: &str, ranked: &[ScoredMemo]) -> String {
    let plural = if ranked.len() == 1 { "" } else { "s" };
    let mut lines = vec![
        format!(
            "Found {} relevant memory memo{plural} for query \"{query}\":",
            ranked.len()
        ),
        String::new(),
    ];
    for (index, scored) in ranked.iter().enumerate() {
        let memo = &scored.memo;
        let source = memo
            .source_session_title
            .as_deref()
            .filter(|title| !title.is_empty())
            .map(|title| format!(" (from: {title})"))
            .unwrap_or_default();
        lines.push(format!("**{}. {}{source}**", index + 1, memo.user_need));
        lines.push(format!("  Score: {:.3}", scored.score));
        if !memo.project_dir.is_empty() {
            lines.push(format!("  Project: {}", memo.project_dir));
        }
        if !memo.tags.is_empty() {
            lines.push(format!("  Tags: {}", memo.tags.join(", ")));
        }
        lines.push(format!("  Approach: {}", memo.approach));
        lines.push(format!("  Outcome: {}", memo.outcome));
        if memo.what_failed != "none" {
            lines.push(format!("  What failed: {}", memo.what_failed));
        }
        if memo.what_worked != "none" {
            lines.push(format!("  What worked: {}", memo.what_worked));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

/// `MemoryWrite` — persist a new memo when the user asks to remember.
pub struct MemoryWriteTool {
    store: Arc<MemoStore>,
    cwd: PathBuf,
    session_id: String,
    engine: Option<Arc<dyn EmbeddingEngine>>,
}

impl MemoryWriteTool {
    pub fn new(
        store: Arc<MemoStore>,
        cwd: PathBuf,
        session_id: String,
        engine: Option<Arc<dyn EmbeddingEngine>>,
    ) -> Self {
        Self {
            store,
            cwd,
            session_id,
            engine,
        }
    }
}

#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "MemoryWrite"
    }

    fn description(&self) -> &str {
        "Write a new memory memo to the global memory memo store. \
         Call this when the user explicitly asks to save an experience, lesson, or summary to memory, \
         for example \"保存到记忆\", \"保存到备忘录\", \"总结并保存\", \"永久记忆\", \"记录我的记忆\", \"记住这个\", \"添加到记忆\", or \"存入记忆库\". \
         Set kind to \"pending\" when the user asks you to remember an unfinished task to resume later. \
         Set kind to \"preference\" when the user asks you to remember a stable habit or preference \
         (\"记住我喜欢用 pnpm\"); preferences are injected into every session so they must stay small and general. \
         Summarize the user need, approach taken, final outcome, what failed, what worked, and 3-5 tags."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["task", "preference", "pending"],
                    "description": "Memo kind. \"preference\" records a stable user habit (language, tooling, style, workflow) that will be injected into every session; \"pending\" records an unfinished task to resume in a later session. Omit or use \"task\" for a task experience record."
                },
                "userNeed": {
                    "type": "string",
                    "description": "The user need or goal, summarized in one sentence. For kind \"preference\": the scene the habit applies to, e.g. \"所有会话\" or \"代码修改\"."
                },
                "approach": {
                    "type": "string",
                    "description": "The approach taken — what was actually done. For kind \"preference\": the rule itself, written so it can be followed directly."
                },
                "outcome": {
                    "type": "string",
                    "description": "Final outcome, e.g. \"完成\", \"部分完成\", \"失败\". For kind \"preference\": use \"已记录为长期偏好\"; for kind \"pending\": use \"未完成\"."
                },
                "whatFailed": {
                    "type": "string",
                    "description": "Dead ends tried — things that did not work. Use \"none\" if nothing notable."
                },
                "whatWorked": {
                    "type": "string",
                    "description": "What ultimately worked — key actions that led to success. Use \"none\" if nothing notable."
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "3-5 semantic tags summarizing the task domain, tech stack, or action type (e.g. [\"react\", \"auth\", \"部署\"])."
                }
            },
            "required": ["userNeed", "approach", "outcome"]
        })
    }

    async fn execute(&self, arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let user_need = arguments["userNeed"]
            .as_str()
            .ok_or("missing `userNeed` argument")?;
        let approach = arguments["approach"]
            .as_str()
            .ok_or("missing `approach` argument")?;
        let outcome = arguments["outcome"]
            .as_str()
            .ok_or("missing `outcome` argument")?;
        let kind = MemoKind::parse(arguments["kind"].as_str().unwrap_or("task"));
        let what_failed = arguments["whatFailed"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        let what_worked = arguments["whatWorked"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        let provided_tags: Vec<String> = arguments["tags"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let tags = if provided_tags.is_empty() {
            generate_tags(&format!("{user_need} {approach}"), 5)
        } else {
            normalize_tags(provided_tags, 5)
        };

        let mut memo = lmcode_memory::MemoryMemo::new(
            user_need,
            approach,
            outcome,
            self.session_id.clone(),
            normalized_dir(&self.cwd),
            kind,
            tags,
        );
        memo.what_failed = if what_failed.is_empty() {
            "none".to_string()
        } else {
            what_failed
        };
        memo.what_worked = if what_worked.is_empty() {
            "none".to_string()
        } else {
            what_worked
        };

        // Embed before persisting (best effort; a failure just skips vectors).
        let embedding: Option<Vec<f32>> = match &self.engine {
            Some(engine) if engine.available() => {
                let text = build_embedding_text(&memo);
                engine
                    .embed(&[text])
                    .await
                    .and_then(|mut vectors| vectors.pop())
            }
            _ => None,
        };
        let model = self
            .engine
            .as_ref()
            .map(|engine| engine.model().to_string());

        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            store.append(&memo).map_err(|error| error.to_string())?;
            if let (Some(vector), Some(model)) = (&embedding, &model) {
                store
                    .upsert_embedding(&memo.id, model, vector)
                    .map_err(|error| error.to_string())?;
            }
            Ok(format!("已保存记忆：{}（id: {}）", memo.user_need, memo.id))
        })
        .await
        .map_err(|error| format!("memory write task failed: {error}"))?
    }
}

/// `MemoryConsolidatePlan` — scan all memos and produce a consolidation plan.
pub struct MemoryConsolidatePlanTool {
    store: Arc<MemoStore>,
}

impl MemoryConsolidatePlanTool {
    pub fn new(store: Arc<MemoStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for MemoryConsolidatePlanTool {
    fn name(&self) -> &str {
        "MemoryConsolidatePlan"
    }

    fn description(&self) -> &str {
        "Scan the global memory memo store and produce a consolidation plan. \
         The plan includes groups of near-duplicate memos to merge, resolved \
         (completed) memos to remove, and stale memos to prune. Present this \
         plan to the user and get their explicit confirmation before calling \
         MemoryConsolidateApply with the exact plan object."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({"type": "object", "properties": {}})
    }

    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(&self, _arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let memos = store.all().map_err(|error| error.to_string())?;
            if memos.is_empty() {
                return Ok("The memory store is empty; nothing to consolidate.".to_string());
            }
            let plan = lmcode_memory::build_consolidation_plan(&memos);
            let json = serde_json::to_string_pretty(&plan)
                .map_err(|error| format!("failed to serialize plan: {error}"))?;
            Ok(format!(
                "Consolidation plan — present it to the user, then pass this exact object to \
                 MemoryConsolidateApply after their confirmation:\n\n```json\n{json}\n```"
            ))
        })
        .await
        .map_err(|error| format!("memory consolidation task failed: {error}"))?
    }
}

/// `MemoryConsolidateApply` — apply a previously shown plan.
pub struct MemoryConsolidateApplyTool {
    store: Arc<MemoStore>,
}

impl MemoryConsolidateApplyTool {
    pub fn new(store: Arc<MemoStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for MemoryConsolidateApplyTool {
    fn name(&self) -> &str {
        "MemoryConsolidateApply"
    }

    fn description(&self) -> &str {
        "Apply a memory consolidation plan produced by MemoryConsolidatePlan. \
         Deletes the original memos in duplicate groups and appends merged \
         replacements, deletes resolved and stale memos, and resets the dream \
         tracker. Only call this after the user has explicitly confirmed the \
         plan shown from MemoryConsolidatePlan."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "description": "The exact plan object returned by MemoryConsolidatePlan.",
            "properties": {
                "duplicateGroups": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Groups of near-duplicate memos with their merged replacements (copied verbatim from the plan)."
                },
                "relatedGroups": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Informational only; never deleted or merged."
                },
                "resolved": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Memos to delete because their outcome indicates completion."
                },
                "stale": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Memos to delete because they have not been updated for over 30 days."
                }
            },
            "required": ["duplicateGroups", "resolved", "stale"]
        })
    }

    async fn execute(&self, arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let plan: ConsolidationPlan = serde_json::from_value(arguments.clone())
            .map_err(|error| format!("invalid consolidation plan: {error}"))?;
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let result = lmcode_memory::apply_consolidation(&store, &plan)
                .map_err(|error| error.to_string())?;
            let skipped = if result.skipped > 0 {
                format!(" ({} skipped: already gone)", result.skipped)
            } else {
                String::new()
            };
            Ok(format!(
                "Consolidation complete. Deleted {} memo(s) and created {} merged memo(s).{skipped}",
                result.deleted, result.created
            ))
        })
        .await
        .map_err(|error| format!("memory consolidation task failed: {error}"))?
    }
}
