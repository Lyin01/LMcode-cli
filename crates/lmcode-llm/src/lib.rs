//! LMcode LLM client — Rust port of `packages/liumir`.
//!
//! Provides a provider-agnostic streaming chat interface. The first provider
//! implemented is the OpenAI-compatible Chat Completions API (`type = "openai"`
//! in `config.toml`), which covers OpenAI, DeepSeek, GLM, Kimi and most
//! gateways. Anthropic / Responses / GenAI providers land in later batches.

pub mod error;
pub mod generate;
pub mod message;
pub mod provider;
pub mod providers;
pub mod sse;
pub mod tool;
pub mod usage;

pub use error::LlmError;
pub use message::{
    ContentPart, ImageUrl, Message, MessageOrigin, Role, StreamedMessagePart, ToolCall,
    merge_in_place,
};
pub use provider::{
    BoxStream, ChatProvider, FinishReason, GenerateOptions, StreamSummary, StreamedMessage,
};
pub use tool::Tool;
pub use usage::TokenUsage;
