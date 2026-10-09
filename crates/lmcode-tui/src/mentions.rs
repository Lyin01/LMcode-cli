//! `@file` mention detection and filesystem-backed completion for the input box.

use std::path::Path;

/// Directories skipped while scanning for mention candidates.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
    "vendor",
];

/// Maximum number of files collected while scanning.
const SCAN_LIMIT: usize = 4000;
/// Maximum directory depth of the scan.
const MAX_DEPTH: usize = 8;

/// Recursively collect relative file paths under `root`, skipping common
/// build/VCS directories. Paths use `/` separators and come back sorted.
pub fn scan_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    walk(root, root, 0, &mut files);
    files.sort();
    files.truncate(SCAN_LIMIT);
    files
}

fn walk(root: &Path, dir: &Path, depth: usize, files: &mut Vec<String>) {
    if depth > MAX_DEPTH || files.len() >= SCAN_LIMIT {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, files);
        } else if file_type.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if files.len() >= SCAN_LIMIT {
            return;
        }
    }
}

/// Rank `files` against a mention query: prefix matches first, then substring
/// matches, case-insensitive, alphabetical within each bucket.
pub fn filter_candidates(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let query = query.to_ascii_lowercase();
    let mut prefix = Vec::new();
    let mut substring = Vec::new();
    for file in files {
        let lower = file.to_ascii_lowercase();
        if query.is_empty() || lower.starts_with(&query) {
            prefix.push(file.clone());
        } else if lower.contains(&query) {
            substring.push(file.clone());
        }
    }
    prefix.extend(substring);
    prefix.truncate(limit);
    prefix
}

/// If the cursor sits inside an unfinished `@token`, return the byte offset of
/// the `@` and the query after it. The mention only triggers at a word
/// boundary (start of input or right after whitespace).
pub fn active_mention(input: &str, byte_cursor: usize) -> Option<(usize, String)> {
    let byte_cursor = byte_cursor.min(input.len());
    let before = &input[..byte_cursor];
    let at = before.rfind('@')?;
    let token = &before[at + 1..];
    if token.contains(char::is_whitespace) {
        return None;
    }
    if at > 0 && !before[..at].chars().next_back()?.is_whitespace() {
        return None;
    }
    Some((at, token.to_string()))
}

/// Replace the active mention token with `@path ` and return the new text and
/// the new cursor position (both byte based).
pub fn apply_mention(input: &str, at: usize, path: &str, byte_cursor: usize) -> (String, usize) {
    let byte_cursor = byte_cursor.min(input.len());
    let mut text = String::with_capacity(input.len() + path.len() + 2);
    text.push_str(&input[..at]);
    text.push('@');
    text.push_str(path);
    text.push(' ');
    text.push_str(&input[byte_cursor..]);
    (text, at + path.len() + 2)
}

/// Byte offset of the given char index (clamped to the string length).
pub fn char_to_byte(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte, _)| byte)
        .unwrap_or(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_active_mention_at_word_boundary() {
        let input = "look at @src/ma";
        assert_eq!(
            active_mention(input, input.len()),
            Some((8, "src/ma".to_string()))
        );
        // `@` in the middle of a word does not trigger.
        assert_eq!(active_mention("mail@host", 9), None);
        // Whitespace after the token closes it.
        assert_eq!(active_mention("see @src and more", 17), None);
        assert_eq!(active_mention("no mention", 10), None);
    }

    #[test]
    fn applies_mention_replacing_the_token() {
        let input = "look at @src/ma now";
        let at = input.find('@').unwrap();
        let cursor = input.find(" now").unwrap();
        let (text, cursor) = apply_mention(input, at, "src/main.rs", cursor);
        assert_eq!(text, "look at @src/main.rs  now");
        assert_eq!(&text[..cursor], "look at @src/main.rs ");
    }

    #[test]
    fn ranks_prefix_matches_first() {
        let files = vec![
            "docs/readme.md".to_string(),
            "src/main.rs".to_string(),
            "src/markdown.rs".to_string(),
        ];
        let out = filter_candidates(&files, "src/ma", 10);
        assert_eq!(out, vec!["src/main.rs", "src/markdown.rs"]);
        // Substring matches still appear.
        let out = filter_candidates(&files, "readme", 10);
        assert_eq!(out, vec!["docs/readme.md"]);
        // Empty query lists everything, capped by the limit.
        assert_eq!(filter_candidates(&files, "", 2).len(), 2);
    }

    #[test]
    fn scans_files_skipping_ignored_dirs() {
        let root = std::env::temp_dir().join(format!("lmcode-mention-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        let files = scan_files(&root);
        assert!(
            files.contains(&"src/main.rs".to_string()),
            "files: {files:?}"
        );
        assert!(files.contains(&"README.md".to_string()), "files: {files:?}");
        assert!(
            !files.iter().any(|f| f.contains("node_modules")),
            "files: {files:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn converts_char_indices_to_byte_offsets() {
        let text = "héllo @wörld";
        assert_eq!(char_to_byte(text, 0), 0);
        assert_eq!(char_to_byte(text, 2), 3);
        assert_eq!(char_to_byte(text, 999), text.len());
    }
}
