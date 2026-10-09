//! MCP configuration loading — `~/.lmcode/mcp.json` plus project-local
//! `<cwd>/.lmcode/mcp.json`; project entries override same-named user entries.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::McpError;

/// One `mcpServers.<name>` entry (stdio or Streamable HTTP transport).
#[derive(Debug, Clone, Deserialize)]
pub struct McpServerConfig {
    /// stdio transport: the executable to spawn.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// HTTP transport: the Streamable HTTP endpoint.
    #[serde(default)]
    pub url: Option<String>,
    /// HTTP transport: extra request headers.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default, rename = "toolTimeoutMs")]
    pub tool_timeout_ms: Option<u64>,
    #[serde(default)]
    pub disabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct McpFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: HashMap<String, McpServerConfig>,
}

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

/// Load enabled servers: user-level first, project-local overrides on top.
pub fn load_servers(cwd: &Path) -> Result<HashMap<String, McpServerConfig>, McpError> {
    load_servers_with_home(cwd, &lmcode_home())
}

/// Variant with an explicit home directory (tests avoid env mutation).
pub fn load_servers_with_home(
    cwd: &Path,
    home: &Path,
) -> Result<HashMap<String, McpServerConfig>, McpError> {
    let mut servers = HashMap::new();
    merge_file(&mut servers, &home.join("mcp.json"))?;
    merge_file(&mut servers, &cwd.join(".lmcode").join("mcp.json"))?;
    servers.retain(|_, config| config.disabled != Some(true));
    Ok(servers)
}

fn merge_file(servers: &mut HashMap<String, McpServerConfig>, path: &Path) -> Result<(), McpError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Ok(()), // missing file is fine
    };
    let parsed: McpFile = serde_json::from_str(&text).map_err(|error| McpError::Config {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    for (name, config) in parsed.mcp_servers {
        servers.insert(name, config);
    }
    Ok(())
}

/// Where a server definition came from (file + parsed config).
#[derive(Debug, Clone)]
pub struct McpServerSource {
    pub file_path: PathBuf,
    pub config: McpServerConfig,
}

/// Load every configured server with its source file (project overrides user,
/// `disabled` entries are kept so the `/mcp` panel can show and remove them).
pub fn load_effective_sources(cwd: &Path) -> Result<HashMap<String, McpServerSource>, McpError> {
    load_effective_sources_with_home(cwd, &lmcode_home())
}

/// Variant with an explicit home directory (tests avoid env mutation).
pub fn load_effective_sources_with_home(
    cwd: &Path,
    home: &Path,
) -> Result<HashMap<String, McpServerSource>, McpError> {
    let mut servers = HashMap::new();
    merge_file_sources(&mut servers, &home.join("mcp.json"))?;
    merge_file_sources(&mut servers, &cwd.join(".lmcode").join("mcp.json"))?;
    Ok(servers)
}

fn merge_file_sources(
    servers: &mut HashMap<String, McpServerSource>,
    path: &Path,
) -> Result<(), McpError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Ok(()),
    };
    let parsed: McpFile = serde_json::from_str(&text).map_err(|error| McpError::Config {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    for (name, config) in parsed.mcp_servers {
        servers.insert(
            name,
            McpServerSource {
                file_path: path.to_path_buf(),
                config,
            },
        );
    }
    Ok(())
}

/// Remove `name` from the file that defines it. Returns the file path when a
/// definition was actually removed (mirrors `removeEffectiveMcpServer`).
pub fn remove_server(cwd: &Path, name: &str) -> Result<Option<PathBuf>, McpError> {
    remove_server_with_home(cwd, &lmcode_home(), name)
}

/// Variant with an explicit home directory (tests avoid env mutation).
pub fn remove_server_with_home(
    cwd: &Path,
    home: &Path,
    name: &str,
) -> Result<Option<PathBuf>, McpError> {
    let sources = load_effective_sources_with_home(cwd, home)?;
    let Some(source) = sources.get(name) else {
        return Ok(None);
    };
    let path = source.file_path.clone();
    let text = std::fs::read_to_string(&path).map_err(|error| McpError::Config {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let mut document: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| McpError::Config {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    let removed = document
        .get_mut("mcpServers")
        .and_then(|value| value.as_object_mut())
        .and_then(|servers| servers.remove(name));
    if removed.is_none() {
        return Ok(None);
    }
    let serialized = serde_json::to_string_pretty(&document).map_err(|error| McpError::Config {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    std::fs::write(&path, format!("{serialized}\n")).map_err(|error| McpError::Config {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(Some(path))
}

/// Insert or replace a server definition in the user-level `mcp.json`
/// (mirrors `upsertUserMcpServer`). A file that exists but is not valid JSON
/// aborts the write instead of being clobbered. Returns the written path.
pub fn upsert_user_server(
    home: &Path,
    name: &str,
    config: &serde_json::Value,
) -> Result<PathBuf, McpError> {
    let path = home.join("mcp.json");
    let config_error = |message: String| McpError::Config {
        path: path.display().to_string(),
        message,
    };
    let mut document: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| {
            config_error(format!(
                "existing mcp.json is not valid JSON (refusing to overwrite): {error}"
            ))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(config_error(error.to_string())),
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| config_error("top level must be a JSON object".to_string()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| config_error("`mcpServers` must be a JSON object".to_string()))?;
    servers.insert(name.to_string(), config.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| config_error(error.to_string()))?;
    }
    let serialized =
        serde_json::to_string_pretty(&document).map_err(|error| config_error(error.to_string()))?;
    std::fs::write(&path, format!("{serialized}\n"))
        .map_err(|error| config_error(error.to_string()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_user_and_project_with_project_override() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".lmcode")).unwrap();
        std::fs::create_dir_all(project.path().join(".lmcode")).unwrap();
        std::fs::write(
            home.path().join(".lmcode/mcp.json"),
            r#"{"mcpServers":{"a":{"command":"echo","args":["hi"]},"b":{"command":"npx","disabled":true}}}"#,
        )
        .unwrap();
        std::fs::write(
            project.path().join(".lmcode/mcp.json"),
            r#"{"mcpServers":{"a":{"command":"override"}}}"#,
        )
        .unwrap();

        // No env mutation: the explicit-home variant keeps this test
        // suite-safe under parallel execution.
        let servers = load_servers_with_home(project.path(), &home.path().join(".lmcode")).unwrap();

        assert_eq!(servers.len(), 1, "disabled server filtered out");
        assert_eq!(
            servers["a"].command.as_deref(),
            Some("override"),
            "project overrides user"
        );
    }

    #[test]
    fn removes_the_effective_server_from_its_source_file() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".lmcode")).unwrap();
        std::fs::create_dir_all(project.path().join(".lmcode")).unwrap();
        std::fs::write(
            home.path().join(".lmcode/mcp.json"),
            r#"{"mcpServers":{"keep":{"command":"echo"},"gone":{"command":"npx"}},"other":1}"#,
        )
        .unwrap();
        std::fs::write(
            project.path().join(".lmcode/mcp.json"),
            r#"{"mcpServers":{"gone":{"command":"override"}}}"#,
        )
        .unwrap();

        // The project file wins, so removal targets it.
        let removed = remove_server_with_home(project.path(), &home.path().join(".lmcode"), "gone")
            .unwrap()
            .expect("server should be removed");
        assert_eq!(removed, project.path().join(".lmcode/mcp.json"));
        let project_text =
            std::fs::read_to_string(project.path().join(".lmcode/mcp.json")).unwrap();
        assert!(!project_text.contains("gone"), "{project_text}");
        // The user file is untouched (still defines `gone`).
        let user_text = std::fs::read_to_string(home.path().join(".lmcode/mcp.json")).unwrap();
        assert!(user_text.contains("gone"), "{user_text}");

        // Removing again now targets the user file; unrelated keys survive.
        let removed = remove_server_with_home(project.path(), &home.path().join(".lmcode"), "gone")
            .unwrap()
            .expect("server should be removed from the user file");
        assert_eq!(removed, home.path().join(".lmcode/mcp.json"));
        let user_text = std::fs::read_to_string(home.path().join(".lmcode/mcp.json")).unwrap();
        assert!(!user_text.contains("gone"), "{user_text}");
        assert!(user_text.contains("\"other\": 1"), "{user_text}");

        // Unknown servers are a no-op.
        assert!(
            remove_server_with_home(project.path(), &home.path().join(".lmcode"), "nope")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn upsert_user_server_creates_and_updates() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join(".lmcode");
        let config = serde_json::json!({"command": "npx", "args": ["-y", "x"]});
        let path = upsert_user_server(&target, "alpha", &config).unwrap();
        assert_eq!(path, target.join("mcp.json"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"alpha\""), "{text}");

        // Updating keeps other entries.
        let beta = serde_json::json!({"command": "beta"});
        upsert_user_server(&target, "beta", &beta).unwrap();
        let updated = serde_json::json!({"command": "npx2"});
        upsert_user_server(&target, "alpha", &updated).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("npx2"), "{text}");
        assert!(text.contains("\"beta\""), "{text}");
    }

    #[test]
    fn upsert_refuses_to_clobber_malformed_config() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join(".lmcode");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("mcp.json"), "{not json").unwrap();
        let error =
            upsert_user_server(&target, "alpha", &serde_json::json!({"command": "x"})).unwrap_err();
        assert!(
            error.to_string().contains("refusing to overwrite"),
            "{error}"
        );
        // The malformed file is untouched.
        assert_eq!(
            std::fs::read_to_string(target.join("mcp.json")).unwrap(),
            "{not json"
        );
    }
}
