//! Contract tests for the `Bash` tool: real shell execution round-trips.
//!
//! These pin the observable contract — stdout is captured, failures surface
//! their exit code — rather than internal implementation details.

use std::path::Path;

use lmcode_core::tools::{BashTool, Tool};

#[tokio::test]
async fn captures_stdout_from_a_real_command() {
    let output = BashTool::new()
        .execute(
            &serde_json::json!({ "command": "echo hello-rust" }),
            Path::new("."),
        )
        .await
        .expect("command should run");
    assert!(
        output.contains("hello-rust"),
        "stdout was not captured, got: {output:?}"
    );
}

#[tokio::test]
async fn reports_exit_code_for_failing_commands() {
    let output = BashTool::new()
        .execute(
            &serde_json::json!({ "command": "echo before-failure && exit 3" }),
            Path::new("."),
        )
        .await
        .expect("command should run");
    assert!(
        output.contains("before-failure"),
        "stdout was not captured, got: {output:?}"
    );
    assert!(
        output.contains("[exit code: 3]"),
        "exit code was not reported, got: {output:?}"
    );
}
