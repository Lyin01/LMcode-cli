//! Tag normalization and generation — mirrors `packages/memory/src/tags.ts`.

use std::collections::HashSet;

use crate::scoring::extract_keywords;

/// Normalize a tag list: lowercase, trim, deduplicate, drop empties, cap at
/// `max` entries.
pub fn normalize_tags(tags: impl IntoIterator<Item = String>, max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for raw in tags {
        let tag = raw.trim().to_lowercase();
        if tag.is_empty() || !seen.insert(tag.clone()) {
            continue;
        }
        result.push(tag);
        if result.len() >= max {
            break;
        }
    }
    result
}

/// Generate a small set of semantic tags from free-form text (keyword
/// extraction fallback when the caller does not supply tags).
pub fn generate_tags(text: &str, max: usize) -> Vec<String> {
    normalize_tags(extract_keywords(text), max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lowercases_dedupes_and_caps() {
        let tags = normalize_tags(
            vec![
                " React ".to_string(),
                "react".to_string(),
                "".to_string(),
                "Auth".to_string(),
                "部署".to_string(),
                "extra".to_string(),
                "sixth".to_string(),
            ],
            5,
        );
        assert_eq!(tags, vec!["react", "auth", "部署", "extra", "sixth"]);
    }

    #[test]
    fn generates_tags_from_mixed_text() {
        let tags = generate_tags("使用 redis 缓存缓存热点数据", 5);
        assert!(tags.contains(&"redis".to_string()), "got: {tags:?}");
        assert!(tags.len() <= 5);
    }
}
