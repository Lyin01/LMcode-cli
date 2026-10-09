//! End-to-end test: spawn the Python mock MCP server, perform the handshake,
//! list its tools, and call them — over a real stdio pipe.

use std::path::PathBuf;

use lmcode_mcp::client::StdioMcpClient;
use lmcode_mcp::{McpServerConfig, qualify_tool_name};
use serde_json::json;

fn python_command() -> Option<&'static str> {
    for candidate in ["python", "python3"] {
        let ok = std::process::Command::new(candidate)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if ok {
            return Some(candidate);
        }
    }
    None
}

fn fixture_server_config() -> Option<McpServerConfig> {
    let command = python_command()?;
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mock_mcp_server.py");
    Some(McpServerConfig {
        command: Some(command.to_string()),
        args: vec![script.to_string_lossy().to_string()],
        env: Default::default(),
        url: None,
        headers: Default::default(),
        tool_timeout_ms: Some(20_000),
        disabled: None,
    })
}

#[tokio::test]
async fn handshake_lists_and_calls_tools_over_stdio() {
    let Some(config) = fixture_server_config() else {
        eprintln!("python is not available; skipping the mock MCP server test");
        return;
    };

    let mut client = StdioMcpClient::spawn("mock", &config)
        .await
        .expect("server should spawn");
    client.initialize().await.expect("handshake should succeed");

    let tools = client
        .list_tools()
        .await
        .expect("tools/list should succeed");
    assert_eq!(tools.len(), 2);
    let echo = tools.iter().find(|tool| tool.name == "echo").unwrap();
    assert!(echo.description.as_deref().unwrap_or("").contains("Echo"));
    assert!(echo.input_schema.is_some());
    assert_eq!(qualify_tool_name("mock", "echo"), "mcp__mock__echo");

    let output = client
        .call_tool("echo", json!({ "text": "hello" }))
        .await
        .expect("tools/call should succeed");
    assert_eq!(output, "echo: hello");

    let failure = client
        .call_tool("fail", json!({}))
        .await
        .expect("isError results still return content");
    assert!(failure.starts_with("error:"), "got: {failure}");

    let unknown = client.call_tool("nope", json!({})).await;
    assert!(
        unknown.is_err(),
        "unknown tool should surface a server error"
    );
}

#[tokio::test]
async fn reports_spawn_failures_clearly() {
    let config = McpServerConfig {
        command: Some("definitely-not-a-real-binary-xyz".to_string()),
        args: vec![],
        env: Default::default(),
        url: None,
        headers: Default::default(),
        tool_timeout_ms: Some(5_000),
        disabled: None,
    };
    let error = match StdioMcpClient::spawn("ghost", &config).await {
        Err(error) => error,
        Ok(_) => panic!("spawn should fail for a missing binary"),
    };
    assert!(error.to_string().contains("ghost"), "got: {error}");
}
