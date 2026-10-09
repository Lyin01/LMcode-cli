//! Provider registry and factory — mirrors `packages/liumir/src/providers/index.ts`.

pub mod anthropic;
pub mod genai;
pub mod lmcode;
pub mod openai;
pub mod responses;
pub mod vertex;

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::LlmError;
use crate::provider::ChatProvider;

/// Provider backend type, mirroring `ProviderTypeSchema` in the TS config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProviderType {
    #[default]
    OpenAi,
    Anthropic,
    Lmcode,
    GoogleGenai,
    OpenAiResponses,
    VertexAi,
}

impl ProviderType {
    /// Parse the `type` string from `config.toml`.
    pub fn parse(raw: &str) -> Result<Self, LlmError> {
        match raw {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "lmcode" => Ok(Self::Lmcode),
            "google-genai" => Ok(Self::GoogleGenai),
            "openai_responses" => Ok(Self::OpenAiResponses),
            "vertexai" => Ok(Self::VertexAi),
            other => Err(LlmError::Config(format!("unknown provider type `{other}`"))),
        }
    }
}

/// Fully resolved provider settings (config + model alias already applied).
#[derive(Debug, Clone, Default)]
pub struct ProviderConfig {
    /// Config-level provider name (e.g. `opencode-go`).
    pub name: String,
    pub provider_type: ProviderType,
    /// Wire model name sent to the API (e.g. `deepseek-v4.1-flash`).
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// Custom headers from the provider config (e.g. gateway session headers).
    pub headers: HashMap<String, String>,
    /// Vertex AI: GCP project id.
    pub project: Option<String>,
    /// Vertex AI: region (defaults to `us-central1`).
    pub location: Option<String>,
    /// Vertex AI: path to a service account JSON key file.
    pub credentials: Option<String>,
}

/// Build a streaming chat provider for the given settings.
pub fn create_provider(config: ProviderConfig) -> Result<Arc<dyn ChatProvider>, LlmError> {
    match config.provider_type {
        ProviderType::OpenAi => Ok(Arc::new(openai::OpenAiChatProvider::new(config)?)),
        ProviderType::Anthropic => Ok(Arc::new(anthropic::AnthropicProvider::new(config)?)),
        ProviderType::OpenAiResponses => Ok(Arc::new(responses::ResponsesProvider::new(config)?)),
        ProviderType::GoogleGenai => Ok(Arc::new(genai::GenaiProvider::new(config)?)),
        ProviderType::VertexAi => Ok(Arc::new(vertex::VertexProvider::new(config)?)),
        ProviderType::Lmcode => Ok(Arc::new(lmcode::LmcodeProvider::new(config)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_types_and_rejects_unknown() {
        assert_eq!(ProviderType::parse("openai").unwrap(), ProviderType::OpenAi);
        assert_eq!(
            ProviderType::parse("openai_responses").unwrap(),
            ProviderType::OpenAiResponses
        );
        assert_eq!(
            ProviderType::parse("google-genai").unwrap(),
            ProviderType::GoogleGenai
        );
        assert!(ProviderType::parse("mystery").is_err());
    }

    #[test]
    fn vertex_provider_requires_project_and_credentials() {
        let config = ProviderConfig {
            name: "test".to_string(),
            provider_type: ProviderType::VertexAi,
            model: "gemini-2.5-flash".to_string(),
            ..Default::default()
        };
        let error = match create_provider(config) {
            Err(error) => error,
            Ok(_) => panic!("expected vertex without project to fail"),
        };
        assert!(error.to_string().contains("project"));
    }
}
