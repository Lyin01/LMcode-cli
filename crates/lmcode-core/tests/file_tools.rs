//! Contract tests for the file tools (Write / Edit / Grep / Glob).
//! Each test defends an externally observable behavior.

use std::path::Path;

use lmcode_core::tools::{EditTool, GlobTool, GrepTool, Tool, WriteTool};

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("create temp dir")
}

#[tokio::test]
async fn write_creates_missing_parent_directories() {
    let dir = tempdir();
    let path = dir.path().join("nested/deeper/note.txt");
    let output = WriteTool
        .execute(
            &serde_json::json!({ "path": path.to_str().unwrap(), "content": "hello" }),
            Path::new("."),
        )
        .await
        .expect("write should succeed");
    assert!(output.starts_with("Wrote 5 bytes"), "got: {output}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
}

#[tokio::test]
async fn write_append_does_not_add_newline() {
    let dir = tempdir();
    let path = dir.path().join("log.txt");
    std::fs::write(&path, "first").unwrap();
    let output = WriteTool
        .execute(
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "content": "second",
                "mode": "append"
            }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(output.starts_with("Appended 6 bytes"), "got: {output}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "firstsecond");
}

#[tokio::test]
async fn edit_replaces_unique_occurrence_and_reports_count() {
    let dir = tempdir();
    let path = dir.path().join("code.txt");
    std::fs::write(&path, "alpha beta gamma").unwrap();
    let output = EditTool
        .execute(
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "old_string": "beta",
                "new_string": "BETA"
            }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(
        output.contains("Replaced 1 occurrence"),
        "unexpected message: {output}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "alpha BETA gamma");
}

#[tokio::test]
async fn edit_rejects_missing_and_non_unique_old_string() {
    let dir = tempdir();
    let path = dir.path().join("dup.txt");
    std::fs::write(&path, "x x").unwrap();
    let path_str = path.to_str().unwrap();

    let missing = EditTool
        .execute(
            &serde_json::json!({ "path": path_str, "old_string": "nope", "new_string": "y" }),
            Path::new("."),
        )
        .await
        .unwrap_err();
    assert!(missing.contains("not found"), "got: {missing}");

    let ambiguous = EditTool
        .execute(
            &serde_json::json!({ "path": path_str, "old_string": "x", "new_string": "y" }),
            Path::new("."),
        )
        .await
        .unwrap_err();
    assert!(ambiguous.contains("not unique"), "got: {ambiguous}");

    let all = EditTool
        .execute(
            &serde_json::json!({
                "path": path_str,
                "old_string": "x",
                "new_string": "y",
                "replace_all": true
            }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(all.contains("2 occurrences"), "got: {all}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "y y");
}

#[tokio::test]
async fn edit_preserves_pure_crlf_line_endings() {
    let dir = tempdir();
    let path = dir.path().join("win.txt");
    std::fs::write(&path, "line1\r\nline2\r\n").unwrap();
    EditTool
        .execute(
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "old_string": "line2",
                "new_string": "LINE2"
            }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "line1\r\nLINE2\r\n",
        "CRLF must round-trip"
    );
}

#[tokio::test]
async fn grep_supports_all_output_modes() {
    let dir = tempdir();
    std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "gamma\n").unwrap();
    std::fs::write(dir.path().join("c.log"), "beta\n").unwrap();
    let root = dir.path().to_str().unwrap();

    let files = GrepTool
        .execute(
            &serde_json::json!({ "pattern": "beta", "path": root }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(files.contains("a.txt"), "got: {files}");
    assert!(files.contains("c.log"), "got: {files}");
    assert!(!files.contains("b.txt"), "got: {files}");

    let content = GrepTool
        .execute(
            &serde_json::json!({ "pattern": "beta", "path": root, "output_mode": "content" }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(content.contains("a.txt:2:beta"), "got: {content}");
    assert!(content.contains("c.log:1:beta"), "got: {content}");

    let counts = GrepTool
        .execute(
            &serde_json::json!({ "pattern": "a", "path": root, "output_mode": "count_matches" }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(counts.contains("a.txt:3"), "got: {counts}");
    assert!(counts.contains("c.log:1"), "got: {counts}");
}

#[tokio::test]
async fn grep_reports_empty_results_and_respects_glob_filter() {
    let dir = tempdir();
    std::fs::write(dir.path().join("a.txt"), "beta\n").unwrap();
    std::fs::write(dir.path().join("b.log"), "beta\n").unwrap();
    let root = dir.path().to_str().unwrap();

    let filtered = GrepTool
        .execute(
            &serde_json::json!({ "pattern": "beta", "path": root, "glob": "*.txt" }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(filtered.contains("a.txt"), "got: {filtered}");
    assert!(!filtered.contains("b.log"), "got: {filtered}");

    let empty = GrepTool
        .execute(
            &serde_json::json!({ "pattern": "zzz-not-present", "path": root }),
            Path::new("."),
        )
        .await
        .unwrap();
    assert!(empty.contains("No matches found"), "got: {empty}");
}

#[tokio::test]
async fn glob_sorts_by_mtime_and_rejects_pure_wildcards() {
    let dir = tempdir();
    std::fs::write(dir.path().join("old.rs"), "x").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    std::fs::write(dir.path().join("new.rs"), "y").unwrap();
    let root = dir.path().to_str().unwrap();

    let output = GlobTool
        .execute(
            &serde_json::json!({ "pattern": "*.rs", "path": root }),
            Path::new("."),
        )
        .await
        .unwrap();
    let lines: Vec<&str> = output.lines().collect();
    assert_eq!(lines[0], "new.rs", "most recent first; got: {output}");
    assert_eq!(lines[1], "old.rs", "got: {output}");
    assert!(output.contains("Found 2 matches"), "got: {output}");

    let error = GlobTool
        .execute(&serde_json::json!({ "pattern": "**" }), Path::new("."))
        .await
        .unwrap_err();
    assert!(error.contains("literal anchor"), "got: {error}");
}
