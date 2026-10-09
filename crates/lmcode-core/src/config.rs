//! LMcode configuration loading — reads the same `~/.lmcode/config.toml` as
//! the TypeScript implementation (`packages/agent-core/src/config`).
//!
//! Only the subset needed by the minimal turn loop is modeled. Unknown keys
//! are ignored, so the full TS config file parses cleanly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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

/// How the session treats tool calls that no earlier policy settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Manual,
    Yolo,
    Auto,
}

/// Hard file boundary. Independent of [`PermissionMode`], and not bypassed by yolo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

/// `allow` / `deny` / `ask` on one permission rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleDecision {
    Allow,
    Deny,
    Ask,
}

/// Where a permission rule came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RuleScope {
    TurnOverride,
    SessionRuntime,
    Project,
    #[default]
    User,
}

/// One `[[permission.rules]]` entry, already folded from legacy allow/deny/ask tables.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredPermissionRule {
    pub decision: RuleDecision,
    #[serde(default)]
    pub scope: RuleScope,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `[permission]` as stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PermissionConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<StoredPermissionRule>,
}

/// `[loop_control]`. `max_steps_per_run` is accepted as an alias of `max_steps_per_turn`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LoopControlConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps_per_turn: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries_per_step: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_ralph_iterations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_post_write_reviews_per_turn: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_context_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_trigger_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_budget_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_tool_result_image_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub micro_compaction_working_set_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_block_timeout_ms: Option<u64>,
}

/// Desktop computer-use permission mode (`standard` / `bounded` / `unrestricted`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerUsePermissionMode {
    Standard,
    Bounded,
    Unrestricted,
}

/// `[computer_use]`. An empty section means disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerUseConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<ComputerUsePermissionMode>,
}

/// Raw `config.toml` document.
///
/// [`load_config`] keeps sections this struct does not model and
/// [`save_config`] writes them back. The settings-panel sections
/// `permission`, `loop_control`, and `computer_use` are modeled, so a
/// save cannot drop them.
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
    #[serde(default)]
    pub default_permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub default_file_sandbox: Option<FileSandboxMode>,
    #[serde(default)]
    pub permission: Option<PermissionConfig>,
    #[serde(default)]
    pub loop_control: Option<LoopControlConfig>,
    #[serde(default)]
    pub computer_use: Option<ComputerUseConfig>,
    /// Top-level keys this schema does not own. Preserved across save.
    #[serde(skip)]
    pub extra: toml::Table,
}

/// One `[providers.<name>]` entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawProvider {
    #[serde(default, rename = "type")]
    pub provider_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub custom_headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Vertex AI: GCP project id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Vertex AI: region (defaults to `us-central1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Vertex AI: path to a service account JSON key file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<String>,
}

/// One `[models."<alias>"]` entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawModelAlias {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    parse_config_text(&text).map_err(|error| match error {
        ConfigTextError::Toml(source) => CoreError::ConfigParse {
            path,
            source: Box::new(source),
        },
        ConfigTextError::Invalid(message) => {
            CoreError::Config(format!("{}: {message}", path.display()))
        }
    })
}

/// Write `config` back to `path`, including settings-panel sections and any
/// top-level keys this schema does not model.
pub fn save_config(path: &Path, config: &RawConfig) -> Result<(), CoreError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|source| CoreError::ConfigWrite {
            path: path.to_path_buf(),
            source,
        })?;
    }
    let text = render_config(config).map_err(CoreError::Config)?;
    std::fs::write(path, text).map_err(|source| CoreError::ConfigWrite {
        path: path.to_path_buf(),
        source,
    })
}

#[derive(Debug)]
enum ConfigTextError {
    Toml(toml::de::Error),
    Invalid(String),
}

const OWNED_KEYS: &[&str] = &[
    "providers",
    "default_provider",
    "default_model",
    "models",
    "default_thinking",
    "default_permission_mode",
    "default_file_sandbox",
    "permission",
    "loop_control",
    "computer_use",
];

fn parse_config_text(text: &str) -> Result<RawConfig, ConfigTextError> {
    let mut root: toml::Table = toml::from_str(text).map_err(ConfigTextError::Toml)?;
    let mut owned = toml::Table::new();
    for key in OWNED_KEYS {
        if let Some(value) = root.remove(*key) {
            owned.insert((*key).to_string(), value);
        }
    }
    if let Some(toml::Value::Table(permission)) = owned.get_mut("permission") {
        *permission = normalize_permission_table(permission);
    }
    if let Some(toml::Value::Table(loop_control)) = owned.get_mut("loop_control") {
        normalize_loop_control(loop_control);
    }
    let mut config: RawConfig = toml::Value::Table(owned)
        .try_into()
        .map_err(ConfigTextError::Toml)?;
    validate_permission_rules(&config).map_err(ConfigTextError::Invalid)?;
    config.extra = root;
    Ok(config)
}

fn normalize_permission_table(table: &toml::Table) -> toml::Table {
    let mut rules = Vec::new();
    if let Some(value) = table.get("rules") {
        push_permission_rules(&mut rules, value, None);
    }
    for (key, decision) in [("deny", "deny"), ("allow", "allow"), ("ask", "ask")] {
        if let Some(value) = table.get(key) {
            push_permission_rules(&mut rules, value, Some(decision));
        }
    }
    let mut out = toml::Table::new();
    if !rules.is_empty() {
        out.insert("rules".to_string(), toml::Value::Array(rules));
    }
    out
}

fn push_permission_rules(
    target: &mut Vec<toml::Value>,
    value: &toml::Value,
    decision: Option<&str>,
) {
    let entries: Vec<&toml::Value> = match value {
        toml::Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    for entry in entries {
        target.push(transform_permission_rule(entry, decision));
    }
}

fn transform_permission_rule(value: &toml::Value, decision: Option<&str>) -> toml::Value {
    let Some(table) = value.as_table() else {
        return value.clone();
    };
    let mut out = toml::Table::new();
    if let Some(decision) = decision {
        out.insert(
            "decision".to_string(),
            toml::Value::String(decision.to_string()),
        );
    } else if let Some(decision) = table.get("decision") {
        out.insert("decision".to_string(), decision.clone());
    }
    if let Some(scope) = table.get("scope") {
        out.insert("scope".to_string(), scope.clone());
    }
    if let Some(reason) = table.get("reason") {
        out.insert("reason".to_string(), reason.clone());
    }
    let tool = table.get("tool").and_then(toml::Value::as_str);
    let match_pattern = table.get("match").and_then(toml::Value::as_str);
    let pattern = table.get("pattern").and_then(toml::Value::as_str);
    if let Some(tool) = tool {
        let pattern = match match_pattern.or(pattern) {
            Some(arg) => format!("{tool}({arg})"),
            None => tool.to_string(),
        };
        out.insert("pattern".to_string(), toml::Value::String(pattern));
    } else if let Some(pattern) = pattern {
        out.insert(
            "pattern".to_string(),
            toml::Value::String(pattern.to_string()),
        );
    }
    toml::Value::Table(out)
}

fn normalize_loop_control(table: &mut toml::Table) {
    if !table.contains_key("max_steps_per_turn")
        && let Some(value) = table.remove("max_steps_per_run")
    {
        table.insert("max_steps_per_turn".to_string(), value);
    } else {
        table.remove("max_steps_per_run");
    }
}

fn validate_permission_rules(config: &RawConfig) -> Result<(), String> {
    let Some(permission) = &config.permission else {
        return Ok(());
    };
    for rule in &permission.rules {
        crate::permission_chain::parse_pattern(&rule.pattern)?;
    }
    Ok(())
}

fn render_config(config: &RawConfig) -> Result<String, String> {
    let mut table = config.extra.clone();
    for deprecated in ["default_yolo", "defaultYolo", "defaultPermissionMode"] {
        table.remove(deprecated);
    }
    insert_section(
        &mut table,
        "providers",
        &config.providers,
        !config.providers.is_empty(),
    )?;
    insert_scalar(&mut table, "default_provider", &config.default_provider);
    insert_scalar(&mut table, "default_model", &config.default_model);
    insert_section(
        &mut table,
        "models",
        &config.models,
        !config.models.is_empty(),
    )?;
    insert_bool(&mut table, "default_thinking", config.default_thinking);
    insert_scalar_display(
        &mut table,
        "default_permission_mode",
        config.default_permission_mode.map(permission_mode_name),
    );
    insert_scalar_display(
        &mut table,
        "default_file_sandbox",
        config.default_file_sandbox.map(file_sandbox_name),
    );
    match &config.permission {
        Some(permission) if !permission.rules.is_empty() => {
            insert_section(&mut table, "permission", permission, true)?;
        }
        _ => {
            table.remove("permission");
        }
    }
    match &config.loop_control {
        Some(loop_control) if loop_control_is_set(loop_control) => {
            insert_section(&mut table, "loop_control", loop_control, true)?;
        }
        _ => {
            table.remove("loop_control");
        }
    }
    match &config.computer_use {
        Some(computer_use) => insert_section(&mut table, "computer_use", computer_use, true)?,
        None => {
            table.remove("computer_use");
        }
    }
    let rendered = toml::to_string_pretty(&table).map_err(|error| error.to_string())?;
    Ok(format!("{rendered}\n"))
}

fn insert_section<T: Serialize>(
    table: &mut toml::Table,
    key: &str,
    value: &T,
    keep: bool,
) -> Result<(), String> {
    if !keep {
        table.remove(key);
        return Ok(());
    }
    table.insert(key.to_string(), to_toml_value(value)?);
    Ok(())
}

fn insert_scalar(table: &mut toml::Table, key: &str, value: &Option<String>) {
    match value {
        Some(value) => {
            table.insert(key.to_string(), toml::Value::String(value.clone()));
        }
        None => {
            table.remove(key);
        }
    }
}

fn insert_scalar_display(table: &mut toml::Table, key: &str, value: Option<&str>) {
    match value {
        Some(value) => {
            table.insert(key.to_string(), toml::Value::String(value.to_string()));
        }
        None => {
            table.remove(key);
        }
    }
}

fn insert_bool(table: &mut toml::Table, key: &str, value: Option<bool>) {
    match value {
        Some(value) => {
            table.insert(key.to_string(), toml::Value::Boolean(value));
        }
        None => {
            table.remove(key);
        }
    }
}

fn to_toml_value<T: Serialize>(value: &T) -> Result<toml::Value, String> {
    let text = toml::to_string(value).map_err(|error| error.to_string())?;
    toml::from_str(&text).map_err(|error| error.to_string())
}

fn permission_mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Manual => "manual",
        PermissionMode::Yolo => "yolo",
        PermissionMode::Auto => "auto",
    }
}

fn file_sandbox_name(mode: FileSandboxMode) -> &'static str {
    match mode {
        FileSandboxMode::ReadOnly => "read-only",
        FileSandboxMode::WorkspaceWrite => "workspace-write",
        FileSandboxMode::FullAccess => "full-access",
    }
}

fn loop_control_is_set(loop_control: &LoopControlConfig) -> bool {
    loop_control.max_steps_per_turn.is_some()
        || loop_control.max_retries_per_step.is_some()
        || loop_control.max_ralph_iterations.is_some()
        || loop_control.max_post_write_reviews_per_turn.is_some()
        || loop_control.reserved_context_size.is_some()
        || loop_control.compaction_trigger_ratio.is_some()
        || loop_control.media_budget_bytes.is_some()
        || loop_control.media_tool_result_image_limit.is_some()
        || loop_control.micro_compaction_working_set_tokens.is_some()
        || loop_control.compaction_block_timeout_ms.is_some()
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
    fn settings_panel_sections_round_trip_without_being_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let source = r#"
default_model = "opencode-go/deepseek-v4.1-flash"
default_provider = "opencode-go"
default_permission_mode = "auto"
default_file_sandbox = "workspace-write"
default_yolo = true

[providers.opencode-go]
type = "openai"
api_key = "sk-test"
base_url = "https://example.com/v1"

[permission]
mode = "manual"

[[permission.rules]]
decision = "deny"
scope = "user"
pattern = "Bash(rm *)"
reason = "no rm"

[[permission.allow]]
tool = "Read"
match = "src/**"
reason = "read src"

[loop_control]
max_steps_per_run = 42
max_retries_per_step = 3
compaction_trigger_ratio = 0.85
media_tool_result_image_limit = 4
micro_compaction_working_set_tokens = 150000

[computer_use]
enabled = true
provider = "cua-driver-mcp"
command = "C:\\Tools\\cua-driver.exe"
args = ["mcp"]
permission_mode = "bounded"

[unknown-section]
future-key = "kept"
"#;
        std::fs::write(&path, source).unwrap();
        let config = load_config(Some(&path)).unwrap();
        assert_eq!(config.default_permission_mode, Some(PermissionMode::Auto));
        assert_eq!(
            config.default_file_sandbox,
            Some(FileSandboxMode::WorkspaceWrite)
        );
        let rules = &config.permission.as_ref().unwrap().rules;
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].decision, RuleDecision::Deny);
        assert_eq!(rules[0].pattern, "Bash(rm *)");
        assert_eq!(rules[0].reason.as_deref(), Some("no rm"));
        assert_eq!(rules[1].decision, RuleDecision::Allow);
        assert_eq!(rules[1].pattern, "Read(src/**)");
        assert_eq!(rules[1].scope, RuleScope::User);
        let loop_control = config.loop_control.as_ref().unwrap();
        assert_eq!(loop_control.max_steps_per_turn, Some(42));
        assert_eq!(loop_control.max_retries_per_step, Some(3));
        assert_eq!(loop_control.media_tool_result_image_limit, Some(4));
        assert_eq!(
            loop_control.micro_compaction_working_set_tokens,
            Some(150000)
        );
        let computer = config.computer_use.as_ref().unwrap();
        assert!(computer.enabled);
        assert_eq!(computer.provider.as_deref(), Some("cua-driver-mcp"));
        assert_eq!(
            computer.command.as_deref(),
            Some(r"C:\Tools\cua-driver.exe")
        );
        assert_eq!(computer.args, vec!["mcp".to_string()]);
        assert_eq!(
            computer.permission_mode,
            Some(ComputerUsePermissionMode::Bounded)
        );
        assert_eq!(
            config.providers["opencode-go"].api_key.as_deref(),
            Some("sk-test")
        );

        save_config(&path, &config).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[computer_use]"));
        assert!(text.contains("permission_mode = \"bounded\""));
        assert!(text.contains("[[permission.rules]]"));
        assert!(text.contains("pattern = \"Read(src/**)\""));
        assert!(!text.contains("[[permission.allow]]"));
        assert!(!text.contains("default_yolo"));
        assert!(text.contains("max_steps_per_turn = 42"));
        assert!(!text.contains("max_steps_per_run"));
        assert!(text.contains("future-key = \"kept\""));
        assert!(text.contains("api_key = \"sk-test\""));

        let again = load_config(Some(&path)).unwrap();
        assert_eq!(again.permission, config.permission);
        assert_eq!(again.loop_control, config.loop_control);
        assert_eq!(again.computer_use, config.computer_use);
        assert_eq!(
            again.default_permission_mode,
            config.default_permission_mode
        );
        assert_eq!(again.default_file_sandbox, config.default_file_sandbox);
        assert_eq!(
            again.providers["opencode-go"].api_key.as_deref(),
            Some("sk-test")
        );
    }

    #[test]
    fn empty_computer_use_section_defaults_to_disabled() {
        let config = parse_config_text("[computer_use]\nprovider = \"cua-driver-mcp\"\n").unwrap();
        let computer = config.computer_use.unwrap();
        assert!(!computer.enabled);
        assert_eq!(computer.provider.as_deref(), Some("cua-driver-mcp"));
        assert!(computer.permission_mode.is_none());
    }

    #[test]
    fn rejects_a_permission_pattern_that_does_not_close() {
        let error = parse_config_text(
            "[[permission.rules]]\ndecision = \"deny\"\npattern = \"Bash(rm *\"\n",
        )
        .unwrap_err();
        let ConfigTextError::Invalid(message) = error else {
            panic!("expected a pattern error");
        };
        assert!(message.contains("missing closing paren"));
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
