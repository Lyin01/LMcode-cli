//! End-to-end tests for the OpenAI-compatible provider: a mock HTTP server
//! serves an SSE stream over a real TCP socket and the provider parses it
//! back into assembled content, tool calls, and a stream summary.

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::openai::OpenAiChatProvider;
use lmcode_llm::providers::{ProviderConfig, ProviderType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Spawn a one-shot HTTP server that answers the first request with `response`.
async fn spawn_mock_http(response: String) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();

        // Read request headers.
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
        // Drain any remaining request body so the client is not reset.
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

fn sse_response(body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}")
}

fn sse_line(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

fn provider_for(addr: SocketAddr) -> OpenAiChatProvider {
    OpenAiChatProvider::new(ProviderConfig {
        name: "mock".to_string(),
        provider_type: ProviderType::OpenAi,
        model: "mock-model".to_string(),
        base_url: Some(format!("http://{addr}/v1")),
        api_key: Some("test-key".to_string()),
        headers: Default::default(),
        ..Default::default()
    })
    .unwrap()
}

async fn drain_parts(
    stream: lmcode_llm::provider::StreamedMessage,
) -> (
    Vec<lmcode_llm::message::StreamedMessagePart>,
    std::sync::Arc<std::sync::Mutex<lmcode_llm::provider::StreamSummary>>,
) {
    let summary = stream.summary();
    let mut parts = Vec::new();
    let mut parts_stream = stream.into_parts();
    while let Some(item) = parts_stream.next().await {
        parts.push(item.unwrap());
    }
    (parts, summary)
}

#[tokio::test]
async fn streams_text_reasoning_usage_and_finish_reason() {
    let body = [
        sse_line(
            r#"{"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"think-"},"finish_reason":null}]}"#,
        ),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"reasoning_content":"part"},"finish_reason":null}]}"#,
        ),
        sse_line(r#"{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}"#),
        sse_line(r#"{"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}"#),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}"#,
        ),
        sse_line("[DONE]"),
    ]
    .concat();

    let addr = spawn_mock_http(sse_response(&body)).await;
    let provider = provider_for(addr);
    let stream = provider
        .generate(
            "sys",
            &[],
            &[Message::user("hi")],
            GenerateOptions::default(),
        )
        .await
        .unwrap();
    let (parts, summary) = drain_parts(stream).await;

    let (content, tool_calls) = assemble_parts(parts);
    assert!(tool_calls.is_empty());
    assert_eq!(
        content,
        vec![
            ContentPart::Think {
                think: "think-part".to_string(),
                encrypted: None,
            },
            ContentPart::Text {
                text: "Hello".to_string(),
            },
        ]
    );

    let summary = summary.lock().unwrap();
    assert_eq!(summary.id.as_deref(), Some("cmpl-1"));
    assert_eq!(summary.finish_reason, Some(FinishReason::Completed));
    let usage = summary.usage.unwrap();
    assert_eq!(usage.input_tokens, 7);
    assert_eq!(usage.output_tokens, 3);
    assert_eq!(usage.cache_read_tokens, Some(2));
}

#[tokio::test]
async fn streams_tool_calls_with_incremental_arguments() {
    let body = [
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}"#,
        ),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}"#,
        ),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":null}]}"#,
        ),
        sse_line(r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#),
        sse_line("[DONE]"),
    ]
    .concat();

    let addr = spawn_mock_http(sse_response(&body)).await;
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
    let (parts, summary) = drain_parts(stream).await;

    let (content, calls) = assemble_parts(parts);
    assert!(content.is_empty());
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_a");
    assert_eq!(calls[0].name, "Read");
    assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"path":"a.txt"}"#));
    assert_eq!(
        summary.lock().unwrap().finish_reason,
        Some(FinishReason::ToolCalls)
    );
}

#[tokio::test]
async fn surfaces_api_error_body() {
    let response = concat!(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        r#"{"error":{"message":"invalid api key","type":"auth_error"}}"#
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
        lmcode_llm::LlmError::Api {
            status, message, ..
        } => {
            assert_eq!(status, 401);
            assert_eq!(message, "invalid api key");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn buffers_arguments_that_arrive_before_the_tool_name() {
    // Some gateways emit argument fragments before the naming chunk.
    let body = [
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}"#,
        ),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"Read","arguments":"\"b.txt\"}"}}]},"finish_reason":null}]}"#,
        ),
        sse_line(r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#),
        sse_line("[DONE]"),
    ]
    .concat();

    let addr = spawn_mock_http(sse_response(&body)).await;
    let provider = provider_for(addr);
    let stream = provider
        .generate(
            "sys",
            &[],
            &[Message::user("read")],
            GenerateOptions::default(),
        )
        .await
        .unwrap();
    let (parts, _) = drain_parts(stream).await;

    let (_, calls) = assemble_parts(parts);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "Read");
    assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"path":"b.txt"}"#));
}
