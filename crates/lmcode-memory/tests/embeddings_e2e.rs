//! End-to-end test for the OpenAI-compatible embedding engine: a mock HTTP
//! server answers `/embeddings` (out-of-order `index` included) and the
//! engine maps vectors back to the right texts.

use lmcode_memory::{EmbeddingEngine, OpenAiEmbeddingEngine};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn spawn_mock_http(response: String) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0u8; 16384];
        let mut total = 0usize;
        loop {
            let read = socket.read(&mut buffer[total..]).await.unwrap_or(0);
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
        socket.write_all(response.as_bytes()).await.ok();
        socket.shutdown().await.ok();
    });
    port
}

#[tokio::test]
async fn embeds_texts_and_respects_response_order() {
    // The second item is returned first; the engine must reorder by index.
    let body = r#"{"data":[
        {"index":1,"embedding":[0.0,1.0]},
        {"index":0,"embedding":[1.0,0.0]}
    ]}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let port = spawn_mock_http(response).await;

    let engine = OpenAiEmbeddingEngine::new(
        Some(format!("http://127.0.0.1:{port}/v1")),
        Some("test-key".to_string()),
        Some("text-embedding-test".to_string()),
    );
    assert!(engine.available());
    assert_eq!(engine.model(), "text-embedding-test");

    let texts = vec!["first".to_string(), "second".to_string()];
    let vectors = engine.embed(&texts).await.expect("embedding should work");
    assert_eq!(vectors.len(), 2);
    assert_eq!(vectors[0], vec![1.0, 0.0], "index 0 mapped to first text");
    assert_eq!(vectors[1], vec![0.0, 1.0], "index 1 mapped to second text");
}

#[tokio::test]
async fn embedding_failures_return_none_instead_of_erroring() {
    let response = concat!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        r#"{"error":{"message":"no embeddings endpoint"}}"#
    );
    let port = spawn_mock_http(response.to_string()).await;
    let engine = OpenAiEmbeddingEngine::new(
        Some(format!("http://127.0.0.1:{port}/v1")),
        Some("test-key".to_string()),
        None,
    );
    let result = engine.embed(&["hello".to_string()]).await;
    assert!(result.is_none(), "failures degrade to None");
}

#[tokio::test]
async fn unavailable_engine_never_calls_the_network() {
    let engine = OpenAiEmbeddingEngine::new(None, None, None);
    assert!(!engine.available());
    // Port 1 is unreachable; the call must fail fast to None via availability
    // guards in callers (engine itself returns None for a missing base url).
    let result = engine.embed(&["hello".to_string()]).await;
    assert!(result.is_none());
}
