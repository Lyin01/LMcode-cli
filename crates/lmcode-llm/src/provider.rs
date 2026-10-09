//! Provider-agnostic streaming interface — mirrors `packages/liumir/src/provider.ts`.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::Stream;

use crate::error::LlmError;
use crate::message::{Message, StreamedMessagePart};
use crate::tool::Tool;
use crate::usage::TokenUsage;

/// A boxed, sendable stream.
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

/// Normalized finish-reason signal indicating why a generation stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// Normal completion.
    Completed,
    /// Generation paused so the caller can dispatch tool calls.
    ToolCalls,
    /// Token budget exhausted.
    Truncated,
    /// Content filter or safety policy blocked the response.
    Filtered,
    /// Anthropic-specific `pause_turn`.
    Paused,
    /// Recognized value that fits none of the categories above.
    Other,
}

/// Final values reported by a provider once its stream is drained.
#[derive(Debug, Clone, Default)]
pub struct StreamSummary {
    /// Provider-assigned response identifier.
    pub id: Option<String>,
    /// Token usage statistics.
    pub usage: Option<TokenUsage>,
    /// Normalized finish reason.
    pub finish_reason: Option<FinishReason>,
    /// Raw provider-specific finish reason, preserved verbatim.
    pub raw_finish_reason: Option<String>,
}

/// A stream of message parts plus the summary that fills in as it drains.
pub struct StreamedMessage {
    parts: BoxStream<Result<StreamedMessagePart, LlmError>>,
    summary: Arc<Mutex<StreamSummary>>,
}

impl std::fmt::Debug for StreamedMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamedMessage").finish_non_exhaustive()
    }
}

impl StreamedMessage {
    pub fn new(
        parts: BoxStream<Result<StreamedMessagePart, LlmError>>,
        summary: Arc<Mutex<StreamSummary>>,
    ) -> Self {
        Self { parts, summary }
    }

    /// Consume the stream of parts. The summary stays readable through the
    /// [`Arc`] obtained from [`Self::summary`] before calling this.
    pub fn into_parts(self) -> BoxStream<Result<StreamedMessagePart, LlmError>> {
        self.parts
    }

    /// Shared handle to the summary; read after the stream is drained.
    pub fn summary(&self) -> Arc<Mutex<StreamSummary>> {
        Arc::clone(&self.summary)
    }
}

/// Per-call options for [`ChatProvider::generate`].
#[derive(Debug, Clone, Default)]
pub struct GenerateOptions {
    /// Request-scoped API key; overrides the provider-level key.
    pub api_key: Option<String>,
    /// Request-scoped headers; override provider-level headers.
    pub headers: HashMap<String, String>,
}

/// Unified interface for an LLM chat provider.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// Short identifier for the provider backend (e.g. `"opencode-go"`).
    fn name(&self) -> &str;
    /// Model name passed to the upstream API.
    fn model_name(&self) -> &str;

    /// Send a conversation to the LLM and return a streamed response.
    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
        options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError>;
}
