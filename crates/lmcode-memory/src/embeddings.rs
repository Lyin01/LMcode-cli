//! Embedding engines for vector-assisted memory search.
//!
//! Mirrors the `EmbeddingEngine` interface of `packages/memory/src/embeddings.ts`.
//! The TS implementation runs a local fastembed model (`bge-small-zh-v1.5`);
//! the Rust port ships an OpenAI-compatible `/embeddings` engine instead —
//! zero heavy dependencies and it degrades to pure rule scoring whenever the
//! endpoint is unavailable. A local ONNX engine is a later-batch option.

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::memo::MemoryMemo;

/// Text embedded for a memo (mirrors `buildEmbeddingText`).
pub fn build_embedding_text(memo: &MemoryMemo) -> String {
    format!(
        "{} {} {} {}",
        memo.user_need, memo.approach, memo.what_failed, memo.what_worked
    )
}

/// Pluggable embedding backend.
#[async_trait]
pub trait EmbeddingEngine: Send + Sync {
    /// Whether the engine can produce embeddings right now.
    fn available(&self) -> bool;

    /// Model identifier stored alongside vectors; vectors from different
    /// models are never compared (cosine across models is meaningless).
    fn model(&self) -> &str;

    /// Embed a batch of texts. `None` on any failure — callers fall back to
    /// pure rule scoring.
    async fn embed(&self, texts: &[String]) -> Option<Vec<Vec<f32>>>;
}

/// OpenAI-compatible `/embeddings` engine.
pub struct OpenAiEmbeddingEngine {
    client: reqwest::Client,
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
}

impl OpenAiEmbeddingEngine {
    pub const DEFAULT_MODEL: &'static str = "text-embedding-3-small";

    pub fn new(base_url: Option<String>, api_key: Option<String>, model: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.filter(|url| !url.trim().is_empty()),
            api_key: api_key.filter(|key| !key.trim().is_empty()),
            model: model.unwrap_or_else(|| Self::DEFAULT_MODEL.to_string()),
        }
    }
}

#[async_trait]
impl EmbeddingEngine for OpenAiEmbeddingEngine {
    fn available(&self) -> bool {
        self.base_url.is_some() && self.api_key.is_some()
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn embed(&self, texts: &[String]) -> Option<Vec<Vec<f32>>> {
        let base_url = self.base_url.as_deref()?;
        let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
        let mut request = self
            .client
            .post(&url)
            .json(&json!({ "model": self.model, "input": texts }));
        if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }

        let response = request.send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let value: Value = response.json().await.ok()?;
        let data = value.get("data")?.as_array()?;
        let mut vectors: Vec<(u64, Vec<f32>)> = Vec::with_capacity(data.len());
        for (position, item) in data.iter().enumerate() {
            let embedding = item.get("embedding")?.as_array()?;
            let vector: Vec<f32> = embedding
                .iter()
                .filter_map(Value::as_f64)
                .map(|value| value as f32)
                .collect();
            if vector.is_empty() {
                return None;
            }
            // Sort by the response's own index so non-conforming gateways
            // that reply out of order still map vectors to the right texts.
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(position as u64);
            vectors.push((index, vector));
        }
        vectors.sort_by_key(|(index, _)| *index);
        let vectors: Vec<Vec<f32>> = vectors.into_iter().map(|(_, vector)| vector).collect();
        if vectors.len() != texts.len() {
            return None;
        }
        Some(vectors)
    }
}

/// Local ONNX engine (fastembed `bge-small-zh-v1.5`), compiled in behind the
/// `local-embeddings` feature. The model initialises lazily on first use;
/// when initialisation fails (offline first run, unsupported platform) the
/// engine reports itself unavailable and callers fall back to rule scoring.
#[cfg(feature = "local-embeddings")]
pub struct LocalEmbeddingEngine {
    model: String,
    state: std::sync::Mutex<LocalState>,
}

#[cfg(feature = "local-embeddings")]
enum LocalState {
    Uninitialized,
    Ready(Box<fastembed::TextEmbedding>),
    Failed,
}

#[cfg(feature = "local-embeddings")]
impl LocalEmbeddingEngine {
    /// Stable model identifier stored alongside vectors.
    pub const MODEL: &'static str = "fastembed-bge-small-zh-v1.5";

    pub fn new() -> Self {
        Self {
            model: Self::MODEL.to_string(),
            state: std::sync::Mutex::new(LocalState::Uninitialized),
        }
    }
}

#[cfg(feature = "local-embeddings")]
impl Default for LocalEmbeddingEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "local-embeddings")]
#[async_trait]
impl EmbeddingEngine for LocalEmbeddingEngine {
    fn available(&self) -> bool {
        match self.state.lock() {
            Ok(state) => !matches!(*state, LocalState::Failed),
            Err(_) => false,
        }
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn embed(&self, texts: &[String]) -> Option<Vec<Vec<f32>>> {
        let mut state = self.state.lock().ok()?;
        if matches!(*state, LocalState::Failed) {
            return None;
        }
        if matches!(*state, LocalState::Uninitialized) {
            let options = fastembed::TextInitOptions::new(fastembed::EmbeddingModel::BGESmallZHV15)
                .with_show_download_progress(false);
            match fastembed::TextEmbedding::try_new(options) {
                Ok(model) => *state = LocalState::Ready(Box::new(model)),
                Err(_) => {
                    *state = LocalState::Failed;
                    return None;
                }
            }
        }
        let LocalState::Ready(model) = &mut *state else {
            return None;
        };
        model.embed(texts, None).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo::MemoKind;
    #[test]
    fn builds_embedding_text_from_all_experience_fields() {
        let mut memo = MemoryMemo::new(
            "修复 redis 泄漏",
            "调连接池",
            "完成",
            "s1",
            "/p",
            MemoKind::Task,
            vec![],
        );
        memo.what_failed = "加大超时无效".to_string();
        memo.what_worked = "限制最大连接".to_string();
        let text = build_embedding_text(&memo);
        assert!(text.contains("修复 redis 泄漏"));
        assert!(text.contains("调连接池"));
        assert!(text.contains("加大超时无效"));
        assert!(text.contains("限制最大连接"));
    }

    #[test]
    fn engine_availability_requires_url_and_key() {
        let missing = OpenAiEmbeddingEngine::new(None, Some("k".to_string()), None);
        assert!(!missing.available());
        let missing_key = OpenAiEmbeddingEngine::new(Some("https://x/v1".to_string()), None, None);
        assert!(!missing_key.available());
        let ready = OpenAiEmbeddingEngine::new(
            Some("https://x/v1".to_string()),
            Some("k".to_string()),
            None,
        );
        assert!(ready.available());
        assert_eq!(ready.model(), OpenAiEmbeddingEngine::DEFAULT_MODEL);
    }
}

#[cfg(all(test, feature = "local-embeddings"))]
mod local_tests {
    use super::*;

    #[test]
    fn local_engine_starts_available_and_names_the_model() {
        let engine = LocalEmbeddingEngine::new();
        assert!(engine.available());
        assert_eq!(engine.model(), LocalEmbeddingEngine::MODEL);
    }

    #[tokio::test]
    #[ignore = "downloads the ONNX model on first run"]
    async fn local_engine_embeds_text() {
        let engine = LocalEmbeddingEngine::new();
        let vectors = engine
            .embed(&["修复 redis 泄漏".to_string()])
            .await
            .expect("local model should embed");
        assert_eq!(vectors.len(), 1);
        assert_eq!(vectors[0].len(), 512); // bge-small-zh-v1.5 dimension
    }
}
