//! Keyword extraction and memo ranking — mirrors `packages/memory/src/scoring.ts`.
//!
//! Score = normalized blend of keyword overlap (Jaccard, 45%), recency
//! (90-day linear decay, 25%), project affinity (10%), and tag overlap (5%).

use std::collections::{HashMap, HashSet};

use crate::memo::{MemoryMemo, now_millis};

const KW_WEIGHT: f64 = 0.45;
const RECENCY_WEIGHT: f64 = 0.25;
const PROJECT_WEIGHT: f64 = 0.10;
const TAG_WEIGHT: f64 = 0.05;

/// Chinese + English stopwords (mirrors the TS list).
pub const STOP_WORDS: &[&str] = &[
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也",
    "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
    "它", "们", "那", "些", "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "can", "shall", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
    "through", "during", "before", "after", "above", "below", "between", "and", "but", "or", "nor",
    "not", "so", "yet", "both", "either", "neither", "each", "every", "all", "any", "few", "more",
    "most", "other", "some", "such", "no", "only", "own", "same", "than", "too", "very", "just",
    "because", "about", "what", "which", "who", "whom", "this", "that", "these", "those", "it",
    "its", "he", "she", "they", "we", "how",
];

/// A memo with its computed relevance score.
#[derive(Debug, Clone)]
pub struct ScoredMemo {
    pub memo: MemoryMemo,
    pub score: f64,
}

/// Extract keywords: ASCII words (>= 2 chars, non-stopword) plus, for CJK
/// runs, single characters and adjacent bigrams (bigrams approximate
/// word-level matching without a segmenter).
pub fn extract_keywords(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();

    // Split CJK and alphanumeric runs so "使用redis缓存" becomes "使用 redis 缓存".
    let chars: Vec<char> = lower.chars().collect();
    let mut normalized = String::with_capacity(lower.len() + 8);
    for (index, &character) in chars.iter().enumerate() {
        if index > 0 {
            let previous = chars[index - 1];
            let boundary = (is_cjk(previous) && is_ascii_word(character))
                || (is_ascii_word(previous) && is_cjk(character));
            if boundary {
                normalized.push(' ');
            }
        }
        normalized.push(character);
    }

    let mut tokens: Vec<String> = Vec::new();
    for part in normalized
        .split(|character: char| !(character.is_ascii_alphanumeric() || is_cjk(character)))
    {
        if part.is_empty() {
            continue;
        }
        if part.chars().any(is_cjk) {
            let part_chars: Vec<char> = part.chars().collect();
            for &character in &part_chars {
                let single = character.to_string();
                if !STOP_WORDS.contains(&single.as_str()) {
                    tokens.push(single);
                }
            }
            for window in part_chars.windows(2) {
                tokens.push(format!("{}{}", window[0], window[1]));
            }
        } else if part
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
            && part.len() >= 2
            && !STOP_WORDS.contains(&part)
        {
            tokens.push(part.to_string());
        }
    }

    // Deduplicate, preserving order.
    let mut seen = HashSet::new();
    tokens.retain(|token| seen.insert(token.clone()));
    tokens
}

fn is_cjk(character: char) -> bool {
    matches!(character, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

fn is_ascii_word(character: char) -> bool {
    character.is_ascii_alphanumeric()
}

/// Jaccard similarity `|A ∩ B| / |A ∪ B|` over keyword sets.
fn jaccard(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let set_a: HashSet<&String> = a.iter().collect();
    let set_b: HashSet<&String> = b.iter().collect();
    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

/// Linear recency decay: 1.0 at day 0, 0 at day 90+.
pub fn recency_score(recorded_at_millis: i64) -> f64 {
    let days = (now_millis() - recorded_at_millis) as f64 / (1000.0 * 60.0 * 60.0 * 24.0);
    (1.0 - days / 90.0).max(0.0)
}

/// Cosine similarity clamped to 0 (negative similarity scores nothing).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += (*x as f64) * (*y as f64);
        norm_a += (*x as f64) * (*x as f64);
        norm_b += (*y as f64) * (*y as f64);
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    (dot / (norm_a.sqrt() * norm_b.sqrt())).max(0.0)
}

/// Project affinity: same directory 1.0, same parent 0.3, otherwise 0.
fn project_boost(memo_dir: &str, current_dir: Option<&str>) -> f64 {
    let Some(current) = current_dir.filter(|dir| !dir.is_empty()) else {
        return 0.0;
    };
    if memo_dir == current {
        return 1.0;
    }
    if memo_dir.is_empty() {
        return 0.0;
    }
    let memo_parent = parent_dir(memo_dir);
    let current_parent = parent_dir(current);
    if !memo_parent.is_empty() && memo_parent == current_parent {
        return 0.3;
    }
    0.0
}

fn parent_dir(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(index) if index > 0 => trimmed[..index].to_string(),
        _ => String::new(),
    }
}

/// Build a tag cloud from memos belonging to the given project.
pub fn build_project_tag_cloud(memos: &[MemoryMemo], project_dir: &str) -> HashSet<String> {
    let mut cloud = HashSet::new();
    for memo in memos {
        if memo.project_dir == project_dir {
            for tag in &memo.tags {
                cloud.insert(tag.clone());
            }
        }
    }
    cloud
}

/// Score one memo against a query.
pub fn score_memo(
    memo: &MemoryMemo,
    query: &str,
    current_project_dir: Option<&str>,
    project_tag_cloud: Option<&HashSet<String>>,
) -> f64 {
    let memo_text = format!(
        "{} {} {} {}",
        memo.user_need, memo.approach, memo.what_failed, memo.what_worked
    );
    let keyword_score = jaccard(&extract_keywords(&memo_text), &extract_keywords(query));
    let recency = recency_score(memo.recorded_at);
    let project = project_boost(&memo.project_dir, current_project_dir);
    let tag = match project_tag_cloud {
        Some(cloud) if !memo.tags.is_empty() => {
            let cloud_vec: Vec<String> = cloud.iter().cloned().collect();
            jaccard(&memo.tags, &cloud_vec)
        }
        _ => 0.0,
    };

    let total = KW_WEIGHT + RECENCY_WEIGHT + PROJECT_WEIGHT + TAG_WEIGHT;
    keyword_score * (KW_WEIGHT / total)
        + recency * (RECENCY_WEIGHT / total)
        + project * (PROJECT_WEIGHT / total)
        + tag * (TAG_WEIGHT / total)
}

/// Score and rank memos against a query, returning the top results above
/// `min_score`.
///
/// When `vector_scores` (memo id → cosine similarity) is present, the final
/// score blends 60% rule score with 40% vector score — mirroring the TS mix
/// in `rankMemos`.
pub fn rank_memos(
    memos: &[MemoryMemo],
    query: &str,
    min_score: f64,
    max_results: usize,
    current_project_dir: Option<&str>,
    vector_scores: Option<&HashMap<String, f32>>,
) -> Vec<ScoredMemo> {
    let tag_cloud = current_project_dir.map(|dir| build_project_tag_cloud(memos, dir));
    let mut scored: Vec<ScoredMemo> = memos
        .iter()
        .map(|memo| {
            let rule = score_memo(memo, query, current_project_dir, tag_cloud.as_ref());
            let score = match vector_scores.and_then(|scores| scores.get(&memo.id)) {
                Some(vector) => rule * 0.6 + (*vector as f64).max(0.0) * 0.4,
                None => rule,
            };
            ScoredMemo {
                memo: memo.clone(),
                score,
            }
        })
        .filter(|scored| scored.score >= min_score)
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(max_results);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo::MemoKind;

    fn memo_with(user_need: &str, approach: &str, project: &str) -> MemoryMemo {
        MemoryMemo::new(
            user_need,
            approach,
            "完成",
            "s1",
            project,
            MemoKind::Task,
            vec![],
        )
    }

    #[test]
    fn extracts_ascii_words_and_filters_stopwords() {
        let keywords = extract_keywords("The quick brown fox and the lazy dog");
        assert!(keywords.contains(&"quick".to_string()));
        assert!(keywords.contains(&"brown".to_string()));
        assert!(!keywords.contains(&"the".to_string()));
        assert!(!keywords.contains(&"a".to_string()));
    }

    #[test]
    fn extracts_cjk_singles_and_bigrams() {
        let keywords = extract_keywords("缓存优化");
        assert!(keywords.contains(&"缓".to_string()));
        assert!(keywords.contains(&"缓存".to_string()));
        assert!(keywords.contains(&"存优".to_string()));
        assert!(keywords.contains(&"优化".to_string()));
    }

    #[test]
    fn splits_mixed_cjk_ascii_runs() {
        let keywords = extract_keywords("使用redis缓存");
        assert!(keywords.contains(&"redis".to_string()), "got: {keywords:?}");
        assert!(keywords.contains(&"缓存".to_string()));
    }

    #[test]
    fn jaccard_is_used_for_keyword_overlap() {
        // Identical keyword sets -> 1.0; disjoint -> 0.0.
        let a = vec!["redis".to_string(), "缓存".to_string()];
        assert_eq!(jaccard(&a, &a.clone()), 1.0);
        let b = vec!["postgres".to_string()];
        assert_eq!(jaccard(&a, &b), 0.0);
    }

    #[test]
    fn recency_decays_over_ninety_days() {
        let now = now_millis();
        assert!((recency_score(now) - 1.0).abs() < 0.01);
        let forty_five_days = now - 45 * 24 * 60 * 60 * 1000;
        assert!((recency_score(forty_five_days) - 0.5).abs() < 0.01);
        let ancient = now - 200 * 24 * 60 * 60 * 1000;
        assert_eq!(recency_score(ancient), 0.0);
    }

    #[test]
    fn project_boost_prefers_same_directory_then_same_parent() {
        assert_eq!(project_boost("/a/b", Some("/a/b")), 1.0);
        assert_eq!(project_boost("/a/c", Some("/a/b")), 0.3);
        assert_eq!(project_boost("/x/y", Some("/a/b")), 0.0);
        assert_eq!(project_boost("/a/b", None), 0.0);
        assert_eq!(project_boost("", Some("/a/b")), 0.0);
    }

    #[test]
    fn ranking_prefers_matching_and_recent_memos() {
        let matching = memo_with("redis 缓存优化", "使用连接池", "/proj");
        let unrelated = memo_with("css 布局修复", "调整 flex", "/proj");
        let ranked = rank_memos(
            &[unrelated.clone(), matching.clone()],
            "redis 缓存问题",
            0.05,
            5,
            Some("/proj"),
            None,
        );
        assert_eq!(ranked[0].memo.user_need, "redis 缓存优化");
        assert!(ranked[0].score > ranked[1].score);
    }

    #[test]
    fn ranking_respects_min_score_and_limit() {
        let memos: Vec<MemoryMemo> = (0..10)
            .map(|index| memo_with(&format!("redis task {index}"), "work", "/proj"))
            .collect();
        let ranked = rank_memos(&memos, "redis", 0.05, 3, Some("/proj"), None);
        assert_eq!(ranked.len(), 3);

        let none = rank_memos(
            &memos,
            "completely unrelated query xyz",
            0.95,
            3,
            Some("/proj"),
            None,
        );
        assert!(none.is_empty(), "high min_score filters everything");
    }

    #[test]
    fn cosine_similarity_is_clamped_to_zero() {
        assert!((cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(
            cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]).abs() < 1e-6,
            "negative similarity clamps to 0"
        );
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
        assert_eq!(
            cosine_similarity(&[1.0], &[1.0, 2.0]),
            0.0,
            "length mismatch"
        );
    }

    #[test]
    fn vector_scores_blend_at_sixty_forty() {
        let memo = memo_with("redis 缓存", "连接池", "/proj");
        let mut vectors = HashMap::new();
        vectors.insert(memo.id.clone(), 0.9f32);

        let with_vector = rank_memos(
            std::slice::from_ref(&memo),
            "redis",
            0.0,
            5,
            Some("/proj"),
            Some(&vectors),
        );
        let without = rank_memos(
            std::slice::from_ref(&memo),
            "redis",
            0.0,
            5,
            Some("/proj"),
            None,
        );
        let expected = without[0].score * 0.6 + 0.9 * 0.4;
        assert!(
            (with_vector[0].score - expected).abs() < 1e-6,
            "blended={} expected={expected}",
            with_vector[0].score
        );
    }
}
