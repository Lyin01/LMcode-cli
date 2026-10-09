//! End-to-end tests for the Vertex AI provider: mock HTTP servers serve the
//! `streamGenerateContent?alt=sse` stream (and the OAuth2 token endpoint for
//! service-account mode), and the provider is exercised end to end.

use std::net::SocketAddr;

use futures_util::StreamExt;
use lmcode_llm::generate::assemble_parts;
use lmcode_llm::message::{ContentPart, Message};
use lmcode_llm::provider::{ChatProvider, FinishReason, GenerateOptions};
use lmcode_llm::providers::ProviderConfig;
use lmcode_llm::providers::ProviderType;
use lmcode_llm::providers::vertex::VertexProvider;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Throwaway RSA key used only by these tests (same pair as the unit tests).
const TEST_PRIVATE_KEY: &str = "\
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDJ0X3So2+jll4Z
iLogiPuIku6p5rmw/0siVnknREy0xP+NfEW8iWZYGeDJm9k2oDAkfJuy/ES0OlCg
miKHD/6oHf1GR3fXMHNW4PuVwiVxPU/V6ihpVr4itEXQWVnQ019NyYz9Psin7d7V
NwE3CvxC84uWgCpfbUXc/OmpLyzIZAjKIx7+BprB8XhNgGSyE2r6+N3NxyqAzWgL
itgjgy9y1upvZV+AJBTbsXeJjgdujULTWKL0vE5NMVKIw37wKCGpWR+vA8i1crvs
CsaII/Br73vtaBXslSz6LBWrPNQXLtBn7RJ97rRcFPYD3wZGqTpvMub9cgXi5/Rz
p6uZwKMDAgMBAAECggEAFOXP5mP3tz6RRN9EYq0R2rJYQJiRvtMDR9ggwyD5OQ4I
Zkapfpx9pVQcqNOt+iWRMUiujf89lVSlLP7ON3e/sfnU/ut/QcrpuTkiY/9OsDtI
jTPUy7+TKvXJdYm4WVLMf2Sw6DeRldigO9TDwpwtGI5ZHxRAuaaPgZK2FpzkwWUc
i0enG6IddTO8Ht6h7l+71VsZKuUPHMLxRBLcHFCVTxE6KG+kagE+cW26zBvRyldZ
AGjXf5gIJBg0H/Pr6MqQD/onybx7cNaK9o3lYvGZHathZgiK0odCBaZhRtaoCHpU
D22K92docr/6sHuaLhnWhkt5ySbYS5ABlc2wMgwdyQKBgQDwuMc0jRdcWXgEma6n
AHZmgjjSLjAldJ5mOHGcutJbsfMiFGDdUGjHcDxsBIaFRd24c87FUmOWSY33CDxL
o4HTujwPubtGVCKWuVCuDe4iETlOMPpbdmmeZifS7dkOAoU+c+sQnQ5CvsGthjvY
BCOMusXG6x6juiqgWlpZpc8HGQKBgQDWoJ0x3EGywvD/xFbM49SAWNNqatMbb+kk
QNUVVsvJ6hoG+igegiIiF//VvOZw6CQwPcgZ1mXhwDZyY2J+eZRo9i2ze3m4OAGR
XhOvgrrktUr74YnbXd3gHYlCPCAYhv1VmrFe01noTnkFlstjXGs8Vvpl2xY8My19
BhWB/3NKewKBgBRbK81P2RfgIPwSmuhYa6rDfFaZvUyNjg+K2mCsk7lZVPweyQou
EI48+X8Q6uc+Pz+n22ZoTy+YTL8FHUQwMXxcFVQnGqUZ3ErupNnzJ54N4tCv55vw
aYIRlXCK2H4MzIO5fblL7rbKNsqbvVfJEdCGws7NdyvVRGGHAnjuQpGRAoGAegUI
OY+aPlI8B30NSCEC8BEP6QFgkcm3B2hgfGhDJcEVGQBhjK65Tx7L0S066dfgsxh8
ycutUoIfsjq0hWkDqgTDiLXbRpN4uLd+g5rUPDCht7/Ky097U+4W2fQq3ybnoiJ3
UozgIYVzomzPpualBMICS6QZ6RHDe7/YvHaJij8CgYAXYAEBIcBqker+I6gvgS6i
0iR1UaDqMiROmd5kQ/cF6EW8QbGf6SJd+TYWFUtNVBmHp6+MpoeRgdMzz/qA2mPV
nY93pPYiVza8cNGWpk9nt0IFT0JwDOpt37d/YLWhG4K/NRZm2JpnVO/CGIRmYJc5
7urli2MA7xctRg7BOUQoSg==
-----END PRIVATE KEY-----
";

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
        let mut drain = [0u8; 4096];
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

fn sse(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

async fn collect_text(provider: &VertexProvider) -> (Vec<ContentPart>, FinishReason) {
    let stream = provider
        .generate("", &[], &[Message::user("hi")], GenerateOptions::default())
        .await
        .unwrap();
    let summary = stream.summary();
    let mut parts = Vec::new();
    let mut parts_stream = stream.into_parts();
    while let Some(item) = parts_stream.next().await {
        parts.push(item.unwrap());
    }
    let (content, _calls) = assemble_parts(parts);
    let finish = summary.lock().unwrap().finish_reason.unwrap();
    (content, finish)
}

#[tokio::test]
async fn streams_with_api_key_against_vertex_url() {
    let body = [
        sse(r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}"#),
        sse(
            r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}"#,
        ),
    ]
    .concat();
    let (addr, request_rx) = spawn_mock_http(http_response("text/event-stream", &body)).await;
    let provider = VertexProvider::new(ProviderConfig {
        name: "vertex-mock".to_string(),
        provider_type: ProviderType::VertexAi,
        model: "gemini-2.5-flash".to_string(),
        base_url: Some(format!("http://{addr}")),
        api_key: Some("express-key".to_string()),
        project: Some("demo-project".to_string()),
        location: Some("europe-west4".to_string()),
        ..Default::default()
    })
    .unwrap();

    let (content, finish) = collect_text(&provider).await;
    assert_eq!(
        content,
        vec![ContentPart::Text {
            text: "Hello".to_string()
        }]
    );
    assert_eq!(finish, FinishReason::Completed);

    let request = request_rx.await.unwrap();
    assert!(
        request.contains(
            "POST /v1/projects/demo-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        ),
        "request:\n{request}"
    );
    assert!(
        request.contains("x-goog-api-key: express-key"),
        "request:\n{request}"
    );
}

#[tokio::test]
async fn exchanges_service_account_jwt_for_a_bearer_token() {
    let token_body =
        r#"{"access_token":"ya29.test-token","expires_in":3600,"token_type":"Bearer"}"#;
    let (token_addr, token_rx) =
        spawn_mock_http(http_response("application/json", token_body)).await;
    let api_body = sse(
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}"#,
    );
    let (api_addr, api_rx) = spawn_mock_http(http_response("text/event-stream", &api_body)).await;

    // A service account file pointing the token_uri at the mock endpoint.
    let path = std::env::temp_dir().join(format!("lmcode-vertex-sa-{}.json", std::process::id()));
    std::fs::write(
        &path,
        format!(
            r#"{{"client_email":"svc@example.iam.gserviceaccount.com","private_key":"{}","token_uri":"http://{token_addr}/token"}}"#,
            TEST_PRIVATE_KEY.replace('\n', "\\n")
        ),
    )
    .unwrap();

    let provider = VertexProvider::new(ProviderConfig {
        name: "vertex-sa".to_string(),
        provider_type: ProviderType::VertexAi,
        model: "gemini-2.5-flash".to_string(),
        base_url: Some(format!("http://{api_addr}")),
        credentials: Some(path.to_string_lossy().to_string()),
        project: Some("demo".to_string()),
        ..Default::default()
    })
    .unwrap();

    let (content, finish) = collect_text(&provider).await;
    assert_eq!(
        content,
        vec![ContentPart::Text {
            text: "ok".to_string()
        }]
    );
    assert_eq!(finish, FinishReason::Completed);

    let token_request = token_rx.await.unwrap();
    assert!(
        token_request.contains("POST /token"),
        "token request:\n{token_request}"
    );
    assert!(
        token_request.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"),
        "token request:\n{token_request}"
    );
    // The assertion is a signed JWT (base64url header starts with `eyJ`).
    assert!(
        token_request.contains("assertion=eyJ"),
        "token request:\n{token_request}"
    );

    let api_request = api_rx.await.unwrap();
    assert!(
        api_request.contains("authorization: Bearer ya29.test-token"),
        "api request:\n{api_request}"
    );

    let _ = std::fs::remove_file(&path);
}
