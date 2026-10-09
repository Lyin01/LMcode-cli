//! End-to-end test for the Google GenAI (Gemini) provider: a mock HTTP server
//! serves a `streamGenerateContent?alt=sse` stream and the provider maps it
//! back into content parts, tool calls, and a stream summary.

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::ProviderConfig;
use lmcode_llm::providers::ProviderType;
use lmcode_llm::providers::genai::GenaiProvider;
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

fn provider_for(addr: SocketAddr) -> GenaiProvider {
    GenaiProvider::new(ProviderConfig {
        name: "mock-genai".to_string(),
        provider_type: ProviderType::GoogleGenai,
        model: "gemini-2.5-flash".to_string(),
        base_url: Some(format!("http://{addr}")),
        api_key: Some("test-key".to_string()),
        headers: Default::default(),
        ..Default::default()
    })
    .unwrap()
}

#[tokio::test]
async fn streams_thought_text_tool_call_and_usage() {
    let body = [
        sse(r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"think-","thought":true}]}}]}"#),
        sse(r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"part","thought":true,"thoughtSignature":"sig-1"}]}}]}"#),
        sse(r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}"#),
        sse(r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}"#),
        sse(
            r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"Read","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":5,"cachedContentTokenCount":2}}"#,
        ),
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
                think: "think-part".to_string(),
                encrypted: Some("sig-1".to_string()),
            },
            ContentPart::Text {
                text: "Hello".to_string(),
            },
        ]
    );
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_1");
    assert_eq!(calls[0].name, "Read");
    assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"path":"a.txt"}"#));

    let summary = summary.lock().unwrap();
    assert_eq!(summary.finish_reason, Some(FinishReason::Completed));
    let usage = summary.usage.unwrap();
    assert_eq!(usage.input_tokens, 9);
    assert_eq!(usage.output_tokens, 5);
    assert_eq!(usage.cache_read_tokens, Some(2));
}

#[tokio::test]
async fn maps_safety_finish_reason_to_filtered() {
    let body = sse(
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}"#,
    );
    let addr = spawn_mock_http(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
    ))
    .await;
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
    let summary = stream.summary();
    let mut parts_stream = stream.into_parts();
    while let Some(item) = parts_stream.next().await {
        let _ = item.unwrap();
    }
    assert_eq!(
        summary.lock().unwrap().finish_reason,
        Some(FinishReason::Filtered)
    );
}

#[tokio::test]
async fn surfaces_api_errors() {
    let response = concat!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        r#"{"error":{"message":"API key not valid"}}"#
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
            assert_eq!(status, 400);
            assert_eq!(message, "API key not valid");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}
