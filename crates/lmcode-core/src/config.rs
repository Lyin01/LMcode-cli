//! LMcode configuration loading — reads the same `~/.lmcode/config.toml` as
//! the TypeScript implementation (`packages/agent-core/src/config`).
//!
//! Only the subset needed by the minimal turn loop is modeled. Unknown keys
//! are ignored, so the full TS config file parses cleanly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use lmcode_llm::providers::{ProviderConfig, ProviderType};

use crate::error::CoreError;

/// Resolve the LMcode home directory: `$LMCODE_HOME`, else `~/.lmcode`.
pub fn lmcode_home() -> PathBuf {
    if let Ok(value) = std::env::var("LMCODE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lmcode")
}

/// Default user-level config path.
pub fn default_config_path() -> PathBuf {
    lmcode_home().join("config.toml")
}

/// Raw `config.toml` document (subset).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawConfig {
    #[serde(default)]
    pub providers: HashMap<String, RawProvider>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub models: HashMap<String, RawModelAlias>,
    #[serde(default)]
    pub default_thinking: Option<bool>,
}

/// One `[providers.<name>]` entry.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawProvider {
    #[serde(default, rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Vertex AI: GCP project id.
    #[serde(default)]
    pub project: Option<String>,
    /// Vertex AI: region (defaults to `us-central1`).
    #[serde(default)]
    pub location: Option<String>,
    /// Vertex AI: path to a service account JSON key file.
    #[serde(default)]
    pub credentials: Option<String>,
}

/// One `[models."<alias>"]` entry.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawModelAlias {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub max_context_size: Option<u64>,
    #[serde(default)]
    pub max_output_size: Option<u64>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Load and parse a config file (defaults to [`default_config_path`]).
pub fn load_config(path: Option<&Path>) -> Result<RawConfig, CoreError> {
    let path = path
        .map(Path::to_path_buf)
        .unwrap_or_else(default_config_path);
    let text = std::fs::read_to_string(&path).map_err(|source| CoreError::ConfigRead {
        path: path.clone(),
        source,
    })?;
    toml::from_str(&text).map_err(|source| CoreError::ConfigParse {
        path,
        source: Box::new(source),
    })
}

/// A model selection fully resolved against the config file.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub provider_name: String,
    pub provider_type: ProviderType,
    /// Wire model name sent to the API.
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub headers: HashMap<String, String>,
    /// Vertex AI: GCP project id.
    pub project: Option<String>,
    /// Vertex AI: region (defaults to `us-central1`).
    pub location: Option<String>,
    /// Vertex AI: path to a service account JSON key file.
    pub credentials: Option<String>,
    pub display_name: String,
    /// Context window in tokens (from the model alias), when configured.
    pub max_context_size: Option<u64>,
    /// Output budget in tokens (from the model alias), when configured.
    pub max_output_size: Option<u64>,
}

impl ResolvedModel {
    /// Convert into the provider-layer settings struct.
    pub fn into_provider_config(self) -> ProviderConfig {
        ProviderConfig {
            name: self.provider_name,
            provider_type: self.provider_type,
            model: self.model,
            base_url: self.base_url,
            api_key: self.api_key,
            headers: self.headers,
            project: self.project,
            location: self.location,
            credentials: self.credentials,
        }
    }
}

/// Resolve a model request against the config.
///
/// Lookup order mirrors the TS implementation:
/// 1. exact alias match in `[models]`,
/// 2. `provider/model` form,
/// 3. bare model name combined with `default_provider`.
pub fn resolve_model(
    config: &RawConfig,
    requested: Option<&str>,
) -> Result<ResolvedModel, CoreError> {
    let requested = requested
        .map(str::to_owned)
        .or_else(|| config.default_model.clone())
        .ok_or(CoreError::NoModel)?;

    if let Some(alias) = config.models.get(&requested) {
        let provider = config
            .providers
            .get(&alias.provider)
            .ok_or_else(|| CoreError::UnknownProvider(alias.provider.clone()))?;
        return build_resolved(
            &alias.provider,
            provider,
            &alias.model,
            alias.display_name.clone(),
            alias.max_context_size,
            alias.max_output_size,
        );
    }

    if let Some((provider_name, model)) = requested.split_once('/')
        && let Some(provider) = config.providers.get(provider_name)
    {
        return build_resolved(provider_name, provider, model, None, None, None);
    }

    if let Some(provider_name) = &config.default_provider {
        let provider = config
            .providers
            .get(provider_name)
            .ok_or_else(|| CoreError::UnknownProvider(provider_name.clone()))?;
        return build_resolved(provider_name, provider, &requested, None, None, None);
    }

    Err(CoreError::NoProvider(requested))
}

fn build_resolved(
    name: &str,
    provider: &RawProvider,
    model: &str,
    display_name: Option<String>,
    max_context_size: Option<u64>,
    max_output_size: Option<u64>,
) -> Result<ResolvedModel, CoreError> {
    if provider.enabled == Some(false) {
        return Err(CoreError::ProviderDisabled(name.to_string()));
    }
    if provider.provider_type.trim().is_empty() {
        return Err(CoreError::Config(format!(
            "provider `{name}` is missing its `type` field"
        )));
    }
    let provider_type = ProviderType::parse(&provider.provider_type)
        .map_err(|error| CoreError::Config(format!("provider `{name}`: {error}")))?;
    Ok(ResolvedModel {
        provider_name: name.to_string(),
        provider_type,
        model: model.to_string(),
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        headers: provider.custom_headers.clone(),
        project: provider.project.clone(),
        location: provider.location.clone(),
        credentials: provider.credentials.clone(),
        display_name: display_name.unwrap_or_else(|| format!("{name}/{model}")),
        max_context_size,
        max_output_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
default_thinking = true
default_model = "opencode-go/deepseek-v4.1-flash"
default_provider = "opencode-go"

[providers.opencode-go]
type = "openai"
api_key = "sk-test"
base_url = "https://example.com/v1"
custom_headers = { x-session = "abc" }

[models."opencode-go/deepseek-v4.1-flash"]
provider = "opencode-go"
model = "deepseek-v4.1-flash"
max_context_size = 1000000

[unknown-section]
future-key = "ignored"
"#;

    fn fixture_config() -> RawConfig {
        toml::from_str(FIXTURE).unwrap()
    }

    #[test]
    fn parses_full_config_and_ignores_unknown_sections() {
        let config = fixture_config();
        assert_eq!(config.default_thinking, Some(true));
        assert_eq!(
            config.default_model.as_deref(),
            Some("opencode-go/deepseek-v4.1-flash")
        );
        assert_eq!(config.providers.len(), 1);
    }

    #[test]
    fn resolves_alias_from_config() {
        let resolved = resolve_model(&fixture_config(), None).unwrap();
        assert_eq!(resolved.provider_name, "opencode-go");
        assert_eq!(resolved.model, "deepseek-v4.1-flash");
        assert_eq!(resolved.provider_type, ProviderType::OpenAi);
        assert_eq!(resolved.base_url.as_deref(), Some("https://example.com/v1"));
        assert_eq!(
            resolved.headers.get("x-session").map(String::as_str),
            Some("abc")
        );
        assert_eq!(resolved.api_key.as_deref(), Some("sk-test"));
    }

    #[test]
    fn resolves_provider_slash_model_form() {
        let resolved = resolve_model(&fixture_config(), Some("opencode-go/other-model")).unwrap();
        assert_eq!(resolved.model, "other-model");
        assert_eq!(resolved.provider_name, "opencode-go");
    }

    #[test]
    fn resolves_bare_model_with_default_provider() {
        let resolved = resolve_model(&fixture_config(), Some("glm-5.3")).unwrap();
        assert_eq!(resolved.model, "glm-5.3");
        assert_eq!(resolved.provider_name, "opencode-go");
        assert_eq!(resolved.display_name, "opencode-go/glm-5.3");
    }

    #[test]
    fn errors_when_no_model_is_selected() {
        let config: RawConfig = toml::from_str("").unwrap();
        assert!(matches!(
            resolve_model(&config, None),
            Err(CoreError::NoModel)
        ));
    }

    #[test]
    fn errors_for_unknown_provider_and_disabled_provider() {
        // No alias, no default_provider → the `provider/model` prefix cannot
        // be resolved and there is nothing to fall back to.
        let mut config = fixture_config();
        config.default_provider = None;
        config.default_model = None;
        let error = resolve_model(&config, Some("ghost/model")).unwrap_err();
        assert!(matches!(error, CoreError::NoProvider(_)));

        let mut config = fixture_config();
        config.providers.get_mut("opencode-go").unwrap().enabled = Some(false);
        let error = resolve_model(&config, None).unwrap_err();
        assert!(matches!(error, CoreError::ProviderDisabled(_)));
    }

    #[test]
    fn falls_back_to_default_provider_for_unknown_prefix() {
        // A model name that itself contains a slash (OpenRouter style) is
        // sent verbatim to the default provider when it is not an alias.
        let resolved = resolve_model(&fixture_config(), Some("meta-llama/Llama-3")).unwrap();
        assert_eq!(resolved.provider_name, "opencode-go");
        assert_eq!(resolved.model, "meta-llama/Llama-3");
    }

    #[test]
    fn errors_when_alias_points_at_unknown_provider() {
        let config: RawConfig = toml::from_str(
            r#"
default_model = "m1"
[models.m1]
provider = "ghost"
model = "x"
"#,
        )
        .unwrap();
        let error = resolve_model(&config, None).unwrap_err();
        assert!(matches!(error, CoreError::UnknownProvider(_)));
    }

    #[test]
    fn errors_for_missing_type_field() {
        let config: RawConfig = toml::from_str(
            r#"
default_provider = "p"
[providers.p]
api_key = "k"
"#,
        )
        .unwrap();
        let error = resolve_model(&config, Some("m")).unwrap_err();
        assert!(error.to_string().contains("missing its `type`"));
    }
}
