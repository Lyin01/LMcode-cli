//! End-to-end tests for the LMcode provider: a mock HTTP server serves an SSE
//! stream, and the captured request body is checked for the LMcode wire
//! normalizations (`stream_options.include_usage`, normalized tool schemas).

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::ProviderConfig;
use lmcode_llm::providers::ProviderType;
use lmcode_llm::providers::lmcode::{LmcodeProvider, VideoUpload};
use lmcode_llm::tool::Tool;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Serve one HTTP request, forwarding the raw request text on the channel,
/// then write `response` and close the socket.
async fn spawn_mock_http(response: String) -> (SocketAddr, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 16384];
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
        let mut drain = [0u8; 8192];
        let drained = tokio::time::timeout(
            std::time::Duration::from_millis(150),
            socket.read(&mut drain),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0);
        let mut captured = String::from_utf8_lossy(&buffer[..total]).to_string();
        captured.push_str(&String::from_utf8_lossy(&drain[..drained]));
        let _ = tx.send(captured);
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
    });
    (addr, rx)
}

fn http_response(content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn sse_response(body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}")
}

fn sse_line(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

fn provider_for(addr: SocketAddr) -> LmcodeProvider {
    LmcodeProvider::new(ProviderConfig {
        name: "lmcode-mock".to_string(),
        provider_type: ProviderType::Lmcode,
        model: "lmcode-chat".to_string(),
        base_url: Some(format!("http://{addr}/v1")),
        api_key: Some("test-key".to_string()),
        ..Default::default()
    })
    .unwrap()
}

#[tokio::test]
async fn sends_stream_options_and_normalized_tool_schemas() {
    let body = [
        sse_line(r#"{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}"#),
        sse_line(
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}"#,
        ),
        sse_line("[DONE]"),
    ]
    .concat();
    let (addr, request_rx) = spawn_mock_http(sse_response(&body)).await;
    let provider = provider_for(addr);

    let tool = Tool {
        name: "Mode".to_string(),
        description: "pick a mode".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "mode": { "enum": ["fast", "slow"] },
                "point": { "$ref": "#/$defs/Point" }
            },
            "$defs": {
                "Point": { "properties": { "x": { "enum": [1] } } }
            }
        }),
    };

    let stream = provider
        .generate(
            "sys",
            std::slice::from_ref(&tool),
            &[Message::user("hi")],
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
    let (content, _calls) = assemble_parts(parts);
    assert_eq!(
        content,
        vec![ContentPart::Text {
            text: "ok".to_string()
        }]
    );
    assert_eq!(
        summary.lock().unwrap().finish_reason,
        Some(FinishReason::Completed)
    );

    let request = request_rx.await.unwrap();
    assert!(
        request.contains("POST /v1/chat/completions"),
        "request:\n{request}"
    );
    assert!(
        request.contains(r#""stream_options":{"include_usage":true}"#),
        "request:\n{request}"
    );
    // The enum-only property gained an inferred type.
    assert!(
        request.contains(r#""mode":{"enum":["fast","slow"],"type":"string"}"#),
        "request:\n{request}"
    );
    // The `$ref` was inlined and the definition bucket dropped.
    assert!(
        request.contains(
            r#""point":{"properties":{"x":{"enum":[1],"type":"integer"}},"type":"object"}"#
        ),
        "request:\n{request}"
    );
    assert!(!request.contains("$defs"), "request:\n{request}");
}

#[tokio::test]
async fn requires_a_base_url() {
    let error = match LmcodeProvider::new(ProviderConfig {
        name: "lmcode-mock".to_string(),
        provider_type: ProviderType::Lmcode,
        model: "lmcode-chat".to_string(),
        ..Default::default()
    }) {
        Err(error) => error,
        Ok(_) => panic!("expected a config error"),
    };
    assert!(error.to_string().contains("base_url"));
}

#[tokio::test]
async fn uploads_video_bytes_via_multipart() {
    let (addr, request_rx) = spawn_mock_http(http_response(
        "application/json",
        r#"{"id":"file-abc","object":"file"}"#,
    ))
    .await;
    let provider = provider_for(addr);
    let part = provider
        .upload_video(VideoUpload::Bytes {
            data: b"fake-video-bytes".to_vec(),
            mime_type: "video/mp4".to_string(),
            filename: Some("clip.mp4".to_string()),
        })
        .await
        .unwrap();
    match part {
        ContentPart::VideoUrl { video_url } => {
            assert_eq!(video_url.url, "ms://file-abc");
            assert_eq!(video_url.id.as_deref(), Some("file-abc"));
        }
        other => panic!("unexpected part: {other:?}"),
    }

    let request = request_rx.await.unwrap();
    assert!(request.contains("POST /v1/files"), "request:\n{request}");
    assert!(
        request.contains("multipart/form-data"),
        "request:\n{request}"
    );
    assert!(request.contains("name=\"purpose\""), "request:\n{request}");
    assert!(
        request.contains("filename=\"clip.mp4\""),
        "request:\n{request}"
    );
}

#[tokio::test]
async fn rejects_non_video_uploads() {
    let provider = LmcodeProvider::new(ProviderConfig {
        name: "lmcode-mock".to_string(),
        provider_type: ProviderType::Lmcode,
        model: "lmcode-chat".to_string(),
        base_url: Some("http://127.0.0.1:9/v1".to_string()),
        api_key: Some("k".to_string()),
        ..Default::default()
    })
    .unwrap();
    // In-memory input with a non-video mime type.
    let error = match provider
        .upload_video(VideoUpload::Bytes {
            data: vec![1, 2, 3],
            mime_type: "application/pdf".to_string(),
            filename: None,
        })
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("expected a config error"),
    };
    assert!(error.to_string().contains("video"), "{error}");
    // Path input with a non-video extension.
    let path = std::env::temp_dir().join(format!("lmcode-video-{}.txt", std::process::id()));
    std::fs::write(&path, "not a video").unwrap();
    let error = match provider.upload_video(VideoUpload::Path(path.clone())).await {
        Err(error) => error,
        Ok(_) => panic!("expected a config error"),
    };
    assert!(error.to_string().contains("video"), "{error}");
    let _ = std::fs::remove_file(&path);
}
