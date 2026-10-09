//! Dream consolidation — near-duplicate detection and plan application.
//!
//! Mirrors `packages/memory/src/consolidator.ts`: keyword-similarity clustering
//! (threshold 0.45), merged-record synthesis with cross-time contradiction
//! resolution, resolved/stale detection, and safe application (append the
//! merged record before deleting originals).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::MemoryError;
use crate::memo::{MemoKind, MemoryMemo, now_millis};
use crate::scoring::score_memo;
use crate::store::MemoStore;
use crate::tags::normalize_tags;

pub const SIMILARITY_THRESHOLD: f64 = 0.45;
pub const STALE_DAYS: i64 = 30;

/// A group of near-duplicate memos plus the merged replacement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub memos: Vec<MemoryMemo>,
    pub merged: MergedMemo,
    #[serde(default)]
    pub reason: String,
}

/// Fields of the merged replacement record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedMemo {
    pub user_need: String,
    pub approach: String,
    pub outcome: String,
    #[serde(default = "default_none")]
    pub what_failed: String,
    #[serde(default = "default_none")]
    pub what_worked: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

fn default_none() -> String {
    "none".to_string()
}

/// Memos sharing a topic anchor but not duplicates (informational only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedGroup {
    pub topic: String,
    pub memos: Vec<MemoryMemo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub total_memos: usize,
    pub duplicates_found: usize,
    pub related_groups_found: usize,
    pub resolved_found: usize,
    pub stale_found: usize,
    pub memos_after_consolidation: usize,
}

/// The full consolidation plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationPlan {
    pub duplicate_groups: Vec<DuplicateGroup>,
    /// Topic-sharing memos that are NOT duplicates; never deleted or merged.
    #[serde(default)]
    pub related_groups: Vec<RelatedGroup>,
    pub resolved: Vec<MemoryMemo>,
    pub stale: Vec<MemoryMemo>,
    #[serde(default)]
    pub summary: PlanSummary,
}

/// Outcome of applying a plan.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub deleted: usize,
    pub created: usize,
    pub skipped: usize,
}

/// Build a consolidation plan from all memos (pure logic, no LLM call).
pub fn build_consolidation_plan(memos: &[MemoryMemo]) -> ConsolidationPlan {
    let duplicate_groups = find_duplicate_groups(memos);
    let grouped: HashSet<String> = duplicate_groups
        .iter()
        .flat_map(|group| group.memos.iter().map(|memo| memo.id.clone()))
        .collect();
    let ungrouped: Vec<MemoryMemo> = memos
        .iter()
        .filter(|memo| !grouped.contains(&memo.id))
        .cloned()
        .collect();

    let resolved = find_resolved(&ungrouped);
    let stale = find_stale(&ungrouped, STALE_DAYS);
    let deduped_count: usize = duplicate_groups
        .iter()
        .map(|group| group.memos.len().saturating_sub(1))
        .sum();

    let summary = PlanSummary {
        total_memos: memos.len(),
        duplicates_found: deduped_count,
        related_groups_found: 0,
        resolved_found: resolved.len(),
        stale_found: stale.len(),
        memos_after_consolidation: memos
            .len()
            .saturating_sub(deduped_count + resolved.len() + stale.len()),
    };

    ConsolidationPlan {
        duplicate_groups,
        // Related-group (topic anchor) grouping is a later port; it is
        // informational only and never affects apply.
        related_groups: Vec::new(),
        resolved,
        stale,
        summary,
    }
}

/// Apply a consolidation plan: delete resolved/stale memos and replace each
/// duplicate group with its merged record (append first, then delete).
pub fn apply_consolidation(
    store: &MemoStore,
    plan: &ConsolidationPlan,
) -> Result<ApplyResult, MemoryError> {
    let mut result = ApplyResult::default();

    for memo in &plan.resolved {
        if store.delete(&memo.id)? {
            result.deleted += 1;
        } else {
            result.skipped += 1;
        }
    }
    for memo in &plan.stale {
        if store.delete(&memo.id)? {
            result.deleted += 1;
        } else {
            result.skipped += 1;
        }
    }

    for group in &plan.duplicate_groups {
        let Some(newest) = group.memos.iter().max_by_key(|memo| memo.recorded_at) else {
            continue;
        };
        // Inherit project scope / kind only when every original shares it.
        let first_project = &group.memos[0].project_dir;
        let shared_project = group
            .memos
            .iter()
            .all(|memo| memo.project_dir == *first_project);
        let first_kind = group.memos[0].kind;
        let shared_kind = group.memos.iter().all(|memo| memo.kind == first_kind);
        let merged_tags = group.merged.tags.clone().unwrap_or_else(|| {
            normalize_tags(
                group
                    .memos
                    .iter()
                    .flat_map(|memo| memo.tags.clone())
                    .collect::<Vec<_>>(),
                5,
            )
        });

        let mut merged = MemoryMemo::new(
            group.merged.user_need.clone(),
            group.merged.approach.clone(),
            group.merged.outcome.clone(),
            newest.source_session_id.clone(),
            if shared_project {
                first_project.clone()
            } else {
                String::new()
            },
            if shared_kind {
                first_kind
            } else {
                MemoKind::Task
            },
            merged_tags,
        );
        merged.source_session_title = newest.source_session_title.clone();
        merged.what_failed = group.merged.what_failed.clone();
        merged.what_worked = group.merged.what_worked.clone();
        merged.extraction_source = "compaction".to_string();

        // Append BEFORE deleting: a failed append leaves the group untouched.
        store.append(&merged)?;
        result.created += 1;

        for memo in &group.memos {
            if store.delete(&memo.id)? {
                result.deleted += 1;
            } else {
                result.skipped += 1;
            }
        }
    }

    Ok(result)
}

fn find_duplicate_groups(memos: &[MemoryMemo]) -> Vec<DuplicateGroup> {
    let mut used: HashSet<String> = HashSet::new();
    let mut groups = Vec::new();

    for (index, first) in memos.iter().enumerate() {
        if used.contains(&first.id) {
            continue;
        }
        let mut cluster = vec![first.clone()];
        for candidate in memos.iter().skip(index + 1) {
            if used.contains(&candidate.id) {
                continue;
            }
            let is_similar = cluster.iter().any(|member| {
                let query = format!("{} {}", member.user_need, member.approach);
                score_memo(candidate, &query, None, None) >= SIMILARITY_THRESHOLD
            });
            if is_similar {
                cluster.push(candidate.clone());
            }
        }
        if cluster.len() > 1 {
            for member in &cluster {
                used.insert(member.id.clone());
            }
            groups.push(build_duplicate_group(cluster));
        }
    }
    groups
}

fn build_duplicate_group(cluster: Vec<MemoryMemo>) -> DuplicateGroup {
    let mut sorted = cluster.clone();
    sorted.sort_by_key(|memo| std::cmp::Reverse(memo.recorded_at));
    let newest = sorted[0].clone();

    // Newer half by median time: contradictory older claims are dropped when
    // a newer memo states the opposite.
    let mid = sorted.len().div_ceil(2);
    let newer: Vec<&MemoryMemo> = sorted.iter().take(mid).collect();
    let newer_failed: HashSet<String> = newer
        .iter()
        .flat_map(|memo| split_claims(&memo.what_failed))
        .collect();
    let newer_worked: HashSet<String> = newer
        .iter()
        .flat_map(|memo| split_claims(&memo.what_worked))
        .collect();

    let mut failures: Vec<String> = Vec::new();
    let mut successes: Vec<String> = Vec::new();
    for memo in &cluster {
        for claim in split_claims(&memo.what_failed) {
            if !claims_overlap(&claim, &newer_worked) {
                push_unique(&mut failures, claim);
            }
        }
        for claim in split_claims(&memo.what_worked) {
            if !claims_overlap(&claim, &newer_failed) {
                push_unique(&mut successes, claim);
            }
        }
    }

    let has_done = cluster
        .iter()
        .any(|memo| is_resolved_outcome(&memo.outcome));
    let best_outcome = if has_done {
        "完成".to_string()
    } else {
        newest.outcome.clone()
    };

    DuplicateGroup {
        reason: format!(
            "发现 {} 条相似记录（关键词重叠 > {}%）",
            cluster.len(),
            (SIMILARITY_THRESHOLD * 100.0).round() as u64
        ),
        merged: MergedMemo {
            user_need: newest.user_need.clone(),
            approach: format!(
                "合并 {} 条相关记录。最新方案: {}",
                cluster.len(),
                newest.approach
            ),
            outcome: best_outcome,
            what_failed: if failures.is_empty() {
                "none".to_string()
            } else {
                failures.join("; ")
            },
            what_worked: if successes.is_empty() {
                "none".to_string()
            } else {
                successes.join("; ")
            },
            tags: None,
        },
        memos: cluster,
    }
}

/// Whether an outcome indicates completion.
///
/// Mirrors the TS rule (`完成` / `done`) but additionally excludes partial or
/// unfinished outcomes — `contains("完成")` alone would sweep in "部分完成"
/// and "未完成", and deletion is irreversible.
fn is_resolved_outcome(outcome: &str) -> bool {
    if outcome.contains("部分完成") || outcome.contains("未完成") {
        return false;
    }
    outcome.contains("完成") || outcome.to_lowercase().contains("done")
}

fn find_resolved(memos: &[MemoryMemo]) -> Vec<MemoryMemo> {
    memos
        .iter()
        .filter(|memo| is_resolved_outcome(&memo.outcome))
        .cloned()
        .collect()
}

fn find_stale(memos: &[MemoryMemo], stale_days: i64) -> Vec<MemoryMemo> {
    let cutoff = now_millis() - stale_days * 24 * 60 * 60 * 1000;
    memos
        .iter()
        .filter(|memo| memo.recorded_at < cutoff)
        .cloned()
        .collect()
}

/// Split a whatFailed/whatWorked field into individual claims.
fn split_claims(text: &str) -> Vec<String> {
    if text.is_empty() || text == "none" || text == "无" {
        return Vec::new();
    }
    text.split([';', '；'])
        .map(str::trim)
        .filter(|claim| !claim.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether `claim` shares significant words with any claim in `others`.
fn claims_overlap(claim: &str, others: &HashSet<String>) -> bool {
    let claim_words = significant_words(claim);
    if claim_words.is_empty() {
        return false;
    }
    others.iter().any(|other| {
        let other_words = significant_words(other);
        claim_words.iter().any(|word| other_words.contains(word))
    })
}

/// Significant words for contradiction detection: ASCII runs >= 3 chars plus
/// CJK 2-grams (mirrors the TS helper).
fn significant_words(text: &str) -> HashSet<String> {
    let lower = text.to_lowercase();
    let mut words = HashSet::new();
    let mut ascii_run = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    let flush = |words: &mut HashSet<String>, ascii_run: &mut String, cjk_run: &mut Vec<char>| {
        if ascii_run.len() >= 3 {
            words.insert(ascii_run.clone());
        }
        ascii_run.clear();
        for window in cjk_run.windows(2) {
            words.insert(format!("{}{}", window[0], window[1]));
        }
        cjk_run.clear();
    };

    for character in lower.chars() {
        if character.is_ascii_alphanumeric() {
            if !cjk_run.is_empty() {
                flush(&mut words, &mut ascii_run, &mut cjk_run);
            }
            ascii_run.push(character);
        } else if is_cjk(character) {
            if !ascii_run.is_empty() {
                flush(&mut words, &mut ascii_run, &mut cjk_run);
            }
            cjk_run.push(character);
        } else {
            flush(&mut words, &mut ascii_run, &mut cjk_run);
        }
    }
    flush(&mut words, &mut ascii_run, &mut cjk_run);
    words
}

fn is_cjk(character: char) -> bool {
    matches!(character, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo(user_need: &str, approach: &str, outcome: &str, offset_ms: i64) -> MemoryMemo {
        let mut memo = MemoryMemo::new(
            user_need,
            approach,
            outcome,
            "s1",
            "/proj",
            MemoKind::Task,
            vec![],
        );
        memo.recorded_at = now_millis() + offset_ms;
        memo
    }

    #[test]
    fn clusters_similar_memos_and_ignores_unrelated() {
        let memos = vec![
            memo("修复 redis 连接池泄漏", "调整连接池上限", "完成", -3000),
            memo("修复 redis 连接池泄漏问题", "调整连接池配置", "完成", -2000),
            memo("重写 css 布局", "改用 flexbox", "完成", -1000),
        ];
        let groups = find_duplicate_groups(&memos);
        assert_eq!(groups.len(), 1, "only the redis pair clusters");
        assert_eq!(groups[0].memos.len(), 2);
        assert!(groups[0].reason.contains("2 条相似记录"));
    }

    #[test]
    fn merged_record_prefers_completion_and_newest_approach() {
        let memos = vec![
            memo("部署脚本修复", "旧方案：手动拷贝", "部分完成", -5000),
            memo("部署脚本修复", "新方案：rsync 同步", "完成", -1000),
        ];
        let group = build_duplicate_group(memos);
        assert_eq!(group.merged.outcome, "完成");
        assert!(group.merged.approach.contains("新方案：rsync 同步"));
        assert!(group.merged.approach.starts_with("合并 2 条相关记录"));
    }

    #[test]
    fn newer_claims_override_older_contradictions() {
        let mut older = memo("缓存穿透修复", "方案 A", "完成", -5000);
        older.what_failed = "布隆过滤器误判".to_string();
        let mut newer = memo("缓存穿透修复", "方案 A", "完成", -1000);
        newer.what_worked = "布隆过滤器误判已通过调参解决".to_string();
        let group = build_duplicate_group(vec![older, newer]);
        assert_eq!(
            group.merged.what_failed, "none",
            "older failure dropped when newer memo solved it"
        );
        assert!(group.merged.what_worked.contains("布隆过滤器误判"));
    }

    #[test]
    fn resolved_and_stale_detection() {
        let mut old = memo("很久以前的任务", "a", "部分完成", 0);
        old.recorded_at = now_millis() - 40 * 24 * 60 * 60 * 1000;
        let memos = vec![
            memo("done 的任务", "a", "done", -1000),
            memo("完成的任务", "a", "完成", -1000),
            old,
            memo("进行中的任务", "a", "进行中", -1000),
            memo("半途的任务", "a", "部分完成", -1000),
            memo("未完成的任务", "a", "未完成", -1000),
        ];
        let ungrouped = memos;
        let resolved = find_resolved(&ungrouped);
        assert_eq!(resolved.len(), 2, "partial/unfinished outcomes are kept");
        let stale = find_stale(&ungrouped, STALE_DAYS);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].user_need, "很久以前的任务");
    }

    #[test]
    fn plan_summary_counts_are_consistent() {
        let mut old = memo("陈旧记录", "a", "完成", 0);
        old.recorded_at = now_millis() - 40 * 24 * 60 * 60 * 1000;
        let memos = vec![
            memo("redis 泄漏", "修连接池", "完成", -3000),
            memo("redis 泄漏问题", "修连接池配置", "完成", -2000),
            old,
        ];
        let plan = build_consolidation_plan(&memos);
        assert_eq!(plan.summary.total_memos, 3);
        assert_eq!(plan.summary.duplicates_found, 1);
        assert_eq!(plan.duplicate_groups.len(), 1);
        // The stale memo is also resolved, matching the TS counting.
        assert_eq!(plan.summary.stale_found, 1);
    }

    #[test]
    fn apply_replaces_groups_and_deletes_marked_memos() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoStore::open(&dir.path().join("memos.sqlite")).unwrap();

        let a = memo("redis 泄漏", "修连接池", "完成", -3000);
        let b = memo("redis 泄漏问题", "修连接池配置", "完成", -2000);
        let mut old = memo("陈旧记录", "a", "完成", 0);
        old.recorded_at = now_millis() - 40 * 24 * 60 * 60 * 1000;
        for entry in [&a, &b, &old] {
            store.append(entry).unwrap();
        }

        let plan = build_consolidation_plan(&store.all().unwrap());
        let result = apply_consolidation(&store, &plan).unwrap();

        // merged (1) + group originals (2) + stale (1) = 4 deleted... stale is
        // also resolved here, but deletion is idempotent (skipped on second).
        assert_eq!(result.created, 1);
        assert!(result.deleted >= 3);
        let remaining = store.all().unwrap();
        assert_eq!(remaining.len(), 1, "only the merged record remains");
        assert!(remaining[0].approach.contains("合并 2 条相关记录"));
        assert_eq!(remaining[0].extraction_source, "compaction");
        assert_eq!(
            remaining[0].project_dir, "/proj",
            "shared project inherited"
        );
    }

    #[test]
    fn merged_kind_stays_task_for_mixed_groups() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoStore::open(&dir.path().join("memos.sqlite")).unwrap();
        let a = memo("偏好：用 pnpm", "记录偏好", "完成", -3000);
        let mut b = memo("偏好：用 pnpm 安装", "记录偏好安装方式", "完成", -2000);
        b.kind = MemoKind::Preference;
        store.append(&a).unwrap();
        store.append(&b).unwrap();

        let plan = build_consolidation_plan(&store.all().unwrap());
        apply_consolidation(&store, &plan).unwrap();
        let remaining = store.all().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].kind,
            MemoKind::Task,
            "mixed group falls back to task"
        );
    }
}
