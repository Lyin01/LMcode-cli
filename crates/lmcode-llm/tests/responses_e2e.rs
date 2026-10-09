//! End-to-end test for the OpenAI Responses provider: a mock HTTP server
//! serves a `response.*` SSE stream and the provider maps it back into
//! content parts, tool calls, and a stream summary.

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::ProviderConfig;
use lmcode_llm::providers::ProviderType;
use lmcode_llm::providers::responses::ResponsesProvider;
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

fn sse(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

fn provider_for(addr: SocketAddr) -> ResponsesProvider {
    ResponsesProvider::new(ProviderConfig {
        name: "mock-rsp".to_string(),
        provider_type: ProviderType::OpenAiResponses,
        model: "gpt-5".to_string(),
        base_url: Some(format!("http://{addr}/v1")),
        api_key: Some("test-key".to_string()),
        headers: Default::default(),
        ..Default::default()
    })
    .unwrap()
}

async fn run_stream(
    body: String,
) -> (
    Vec<ContentPart>,
    Vec<lmcode_llm::message::ToolCall>,
    lmcode_llm::provider::StreamSummary,
) {
    let addr = spawn_mock_http(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
    ))
    .await;
    let provider = provider_for(addr);
    let stream = provider
        .generate(
            "sys",
            &[],
            &[Message::user("go")],
            GenerateOptions::default(),
        )
        .await
        .unwrap();
    let summary_handle = stream.summary();
    let mut parts = Vec::new();
    let mut parts_stream = stream.into_parts();
    while let Some(item) = parts_stream.next().await {
        parts.push(item.unwrap());
    }
    let (content, calls) = assemble_parts(parts);
    let summary = summary_handle.lock().unwrap().clone();
    (content, calls, summary)
}

#[tokio::test]
async fn maps_function_calls_text_and_usage() {
    let body = [
        sse(r#"{"type":"response.created","response":{"id":"resp_1"}}"#),
        sse(
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":""}}"#,
        ),
        sse(
            r#"{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"path\":"}"#,
        ),
        sse(
            r#"{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"b.txt\"}"}"#,
        ),
        sse(r#"{"type":"response.output_item.added","output_index":1,"item":{"type":"message"}}"#),
        sse(r#"{"type":"response.output_text.delta","output_index":1,"delta":"reading"}"#),
        sse(
            r#"{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":3}}}}"#,
        ),
    ]
    .concat();

    let (content, calls, summary) = run_stream(body).await;

    assert_eq!(
        content,
        vec![ContentPart::Text {
            text: "reading".to_string(),
        }]
    );
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_1");
    assert_eq!(calls[0].name, "Read");
    assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"path":"b.txt"}"#));

    assert_eq!(summary.id.as_deref(), Some("resp_1"));
    assert_eq!(summary.finish_reason, Some(FinishReason::Completed));
    let usage = summary.usage.unwrap();
    assert_eq!(usage.input_tokens, 12);
    assert_eq!(usage.output_tokens, 7);
    assert_eq!(usage.cache_read_tokens, Some(3));
}

#[tokio::test]
async fn incomplete_responses_map_to_truncated() {
    let body = [
        sse(r#"{"type":"response.created","response":{"id":"resp_2"}}"#),
        sse(r#"{"type":"response.output_text.delta","output_index":0,"delta":"partial"}"#),
        sse(
            r#"{"type":"response.incomplete","response":{"id":"resp_2","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":99}}}"#,
        ),
    ]
    .concat();

    let (content, _, summary) = run_stream(body).await;
    assert_eq!(
        content,
        vec![ContentPart::Text {
            text: "partial".to_string(),
        }]
    );
    assert_eq!(summary.finish_reason, Some(FinishReason::Truncated));
    assert_eq!(
        summary.raw_finish_reason.as_deref(),
        Some("max_output_tokens")
    );
}

#[tokio::test]
async fn failed_responses_surface_as_stream_errors() {
    let body = [
        sse(r#"{"type":"response.created","response":{"id":"resp_3"}}"#),
        sse(r#"{"type":"response.failed","response":{"error":{"message":"model overloaded"}}}"#),
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
            &[Message::user("go")],
            GenerateOptions::default(),
        )
        .await
        .unwrap();
    let mut parts_stream = stream.into_parts();
    let mut error_message = None;
    while let Some(item) = parts_stream.next().await {
        if let Err(error) = item {
            error_message = Some(error.to_string());
        }
    }
    let error_message = error_message.expect("expected a stream error");
    assert!(
        error_message.contains("model overloaded"),
        "got: {error_message}"
    );
}
