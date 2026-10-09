//! Errors produced by the agent runtime layer.

use std::path::PathBuf;

use lmcode_llm::LlmError;

/// Errors produced by configuration loading and model resolution.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("failed to read config `{path}`: {source}")]
    ConfigRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse config `{path}`: {source}")]
    ConfigParse {
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },
    #[error("configuration error: {0}")]
    Config(String),
    #[error("no model selected: pass --model or set `default_model` in config.toml")]
    NoModel,
    #[error("provider `{0}` is not defined in config.toml")]
    UnknownProvider(String),
    #[error("provider `{0}` is disabled in config.toml")]
    ProviderDisabled(String),
    #[error("no provider for model `{0}`: set `default_provider` or use the `provider/model` form")]
    NoProvider(String),
    #[error("session error: {0}")]
    Session(String),
    #[error("compaction error: {0}")]
    Compaction(String),
    #[error(transparent)]
    Llm(#[from] LlmError),
}
