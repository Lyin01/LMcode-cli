//! Error type shared by all LLM providers.

/// Errors produced by the LLM client layer.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    /// Transport-level failure (connection, TLS, body streaming).
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// Non-2xx API response.
    ///
    /// `retry_after_ms` is the server `Retry-After` hint, when one was parsed.
    /// Callers that do not have a hint leave it `None`.
    #[error("API error ({status}): {message}")]
    Api {
        status: u16,
        message: String,
        retry_after_ms: Option<u64>,
    },
    /// A 2xx response that could not be understood (bad JSON, missing fields).
    #[error("invalid API response: {0}")]
    InvalidResponse(String),
    /// An error reported by the provider mid-stream.
    #[error("stream error: {0}")]
    Stream(String),
    /// Misconfiguration detected before any request was sent.
    #[error("configuration error: {0}")]
    Config(String),
}
