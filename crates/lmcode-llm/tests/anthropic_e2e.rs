//! End-to-end test for the Anthropic Messages provider: a mock HTTP server
//! serves an Anthropic-format SSE stream and the provider maps it back into
//! content parts, tool calls, and a stream summary.

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::ProviderConfig;
use lmcode_llm::providers::ProviderType;
use lmcode_llm::providers::anthropic::AnthropicProvider;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn spawn_mock_http(response: String) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 8192];
        let mut total = 0usize;
        loop {
            let read = socket.read(&mut buffer[total..]).await.unwrap();
            if read == 0 {
                break;
            }
            total += read;
            if buffer[..total]
                .windows(4)
                .any(|window| window == b"\r\n\r\n")
            {
                break;
            }
            if total == buffer.len() {
                break;
            }
        }
        let mut drain = [0u8; 4096];
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(150),
            socket.read(&mut drain),
        )
        .await;
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
    });
    addr
}

fn sse(event: &str, payload: &str) -> String {
    format!("event: {event}\ndata: {payload}\n\n")
}

fn provider_for(addr: SocketAddr) -> AnthropicProvider {
    AnthropicProvider::new(ProviderConfig {
        name: "mock-anthropic".to_string(),
        provider_type: ProviderType::Anthropic,
        model: "claude-sonnet-4-5".to_string(),
        base_url: Some(format!("http://{addr}")),
        api_key: Some("test-key".to_string()),
        headers: Default::default(),
        ..Default::default()
    })
    .unwrap()
}

#[tokio::test]
async fn maps_thinking_text_tool_use_and_usage() {
    let body = [
        sse(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":4}}}"#,
        ),
        sse(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}"#,
        ),
        sse("content_block_stop", r#"{"type":"content_block_stop","index":0}"#),
        sse(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}"#,
        ),
        sse(
            "content_block_start",
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
        ),
        sse(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#,
        ),
        sse("content_block_stop", r#"{"type":"content_block_stop","index":2}"#),
        sse(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}"#,
        ),
        sse("message_stop", r#"{"type":"message_stop"}"#),
    ]
    .concat();

    let addr = spawn_mock_http(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
    ))
    .await;
    let provider = provider_for(addr);
    let stream = provider
        .generate(
            "sys",
            &[],
            &[Message::user("read a.txt")],
            GenerateOptions::default(),
        )
        .await
        .unwrap();

    let summary = stream.summary();
    let mut parts = Vec::new();
    let mut parts_stream = stream.into_parts();
    while let Some(item) = parts_stream.next().await {
        parts.push(item.unwrap());
    }
    let (content, calls) = assemble_parts(parts);

    assert_eq!(
        content,
        vec![
            ContentPart::Think {
                think: "pondering".to_string(),
                encrypted: Some("sig-abc".to_string()),
            },
            ContentPart::Text {
                text: "Hello".to_string(),
            },
        ]
    );
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "toolu_1");
    assert_eq!(calls[0].name, "Read");
    assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"path":"a.txt"}"#));

    let summary = summary.lock().unwrap();
    assert_eq!(summary.id.as_deref(), Some("msg_1"));
    assert_eq!(summary.finish_reason, Some(FinishReason::ToolCalls));
    let usage = summary.usage.unwrap();
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.output_tokens, 25);
    assert_eq!(usage.cache_read_tokens, Some(4));
}

#[tokio::test]
async fn surfaces_api_errors() {
    let response = concat!(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
    );
    let addr = spawn_mock_http(response.to_string()).await;
    let provider = provider_for(addr);
    let error = match provider
        .generate(
            "sys",
            &[],
            &[Message::user("hi")],
            GenerateOptions::default(),
        )
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("expected an API error"),
    };
    match error {
        lmcode_llm::LlmError::Api { status, message } => {
            assert_eq!(status, 401);
            assert_eq!(message, "invalid x-api-key");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}
