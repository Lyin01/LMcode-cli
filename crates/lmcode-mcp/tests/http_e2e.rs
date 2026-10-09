//! End-to-end test for the Streamable HTTP transport: a mock HTTP server
//! answers `initialize` (JSON + session header), `tools/list` (SSE), and
//! `tools/call` (JSON) over real TCP.

use lmcode_mcp::{HttpMcpClient, McpServerConfig};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn http_response(status: u16, content_type: &str, session: Option<&str>, body: &str) -> String {
    let mut response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(session) = session {
        response.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(body);
    response
}

/// Serve `responses` in order, one connection per request.
async fn spawn_mock_http(responses: Vec<String>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        for response in responses {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            // Read the request: headers, then the body per Content-Length.
            let mut buffer = vec![0u8; 65536];
            let mut total = 0usize;
            loop {
                let read = socket.read(&mut buffer[total..]).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                total += read;
                if let Some(header_end) = buffer[..total]
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&buffer[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if total - (header_end + 4) >= content_length {
                        break;
                    }
                }
                if total == buffer.len() {
                    break;
                }
            }
            socket.write_all(response.as_bytes()).await.ok();
            socket.shutdown().await.ok();
        }
    });
    port
}

fn http_config(port: u16) -> McpServerConfig {
    McpServerConfig {
        command: None,
        args: vec![],
        env: Default::default(),
        url: Some(format!("http://127.0.0.1:{port}/mcp")),
        headers: Default::default(),
        tool_timeout_ms: Some(20_000),
        disabled: None,
    }
}

#[tokio::test]
async fn http_transport_round_trip_with_json_and_sse_responses() {
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "mock-http", "version": "0.1.0" }
        }
    })
    .to_string();
    let tools_list_sse = format!(
        "data: {}\n\n",
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": "echo",
                    "description": "Echo text",
                    "inputSchema": { "type": "object" }
                }]
            }
        })
    );
    let call_result = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "result": {
            "content": [{ "type": "text", "text": "echo: hi" }],
            "isError": false
        }
    })
    .to_string();

    let responses = vec![
        http_response(200, "application/json", Some("sess-1"), &initialize),
        http_response(202, "application/json", None, ""),
        http_response(200, "text/event-stream", None, &tools_list_sse),
        http_response(200, "application/json", None, &call_result),
    ];
    let port = spawn_mock_http(responses).await;

    let mut client = HttpMcpClient::new("mock-http", &http_config(port)).unwrap();
    client.initialize().await.expect("initialize");
    assert_eq!(
        client.session_id(),
        Some("sess-1"),
        "session header captured from the initialize response"
    );

    let tools = client.list_tools().await.expect("tools/list over SSE");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");

    let output = client
        .call_tool("echo", json!({ "text": "hi" }))
        .await
        .expect("tools/call");
    assert_eq!(output, "echo: hi");
}

#[tokio::test]
async fn http_errors_surface_with_status_and_body() {
    let responses = vec![http_response(
        500,
        "application/json",
        None,
        r#"{"error":{"message":"boom"}}"#,
    )];
    let port = spawn_mock_http(responses).await;
    let mut client = HttpMcpClient::new("mock-http", &http_config(port)).unwrap();
    let error = client.initialize().await.unwrap_err();
    let message = error.to_string();
    assert!(message.contains("500"), "got: {message}");
    assert!(message.contains("boom"), "got: {message}");
}
