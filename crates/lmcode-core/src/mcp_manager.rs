//! Runtime manager for MCP servers: connects at startup, tracks per-server
//! status, and supports enabling/disabling servers from the TUI `/mcp` panel.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use lmcode_mcp::{McpClient, McpError, McpServerConfig};

use crate::tools::Tool;
use crate::tools::mcp::McpToolAdapter;

/// Connection state of one configured MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpStatus {
    Connected,
    Disabled,
    Failed,
}

/// One server's state for the `/mcp` panel.
#[derive(Debug, Clone)]
pub struct McpServerStatus {
    pub name: String,
    pub status: McpStatus,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

struct ServerEntry {
    name: String,
    config: McpServerConfig,
    client: Option<Arc<Mutex<McpClient>>>,
    tools: Vec<Arc<dyn Tool>>,
    error: Option<String>,
}

impl ServerEntry {
    fn status(&self) -> McpStatus {
        if self.client.is_some() {
            McpStatus::Connected
        } else if self.error.is_some() {
            McpStatus::Failed
        } else {
            McpStatus::Disabled
        }
    }
}

/// Owns MCP connections and their tool adapters for the whole process.
pub struct McpManager {
    cwd: PathBuf,
    servers: Vec<ServerEntry>,
}

impl McpManager {
    /// Load config and connect to every server, returning the manager, the
    /// tools to register with the agent, and `(ok, message)` log lines.
    pub async fn start_all(cwd: &Path) -> (Self, Vec<Arc<dyn Tool>>, Vec<(bool, String)>) {
        let mut manager = Self {
            cwd: cwd.to_path_buf(),
            servers: Vec::new(),
        };
        let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
        let mut log: Vec<(bool, String)> = Vec::new();
        let sources = match lmcode_mcp::config::load_effective_sources(cwd) {
            Ok(sources) => sources,
            Err(error) => {
                log.push((false, format!("mcp config: {error}")));
                return (manager, tools, log);
            }
        };
        // Stable order keeps the panel deterministic.
        let mut names: Vec<String> = sources.keys().cloned().collect();
        names.sort();
        for name in names {
            let source = &sources[&name];
            let mut entry = ServerEntry {
                name: name.clone(),
                config: source.config.clone(),
                client: None,
                tools: Vec::new(),
                error: None,
            };
            if source.config.disabled == Some(true) {
                log.push((true, format!("mcp: {name} · disabled")));
            } else {
                match connect_entry(&mut entry).await {
                    Ok(()) => {
                        log.push((
                            true,
                            format!("mcp: {} · {} tool(s)", name, entry.tools.len()),
                        ));
                        tools.extend(entry.tools.iter().cloned());
                    }
                    Err(error) => {
                        entry.error = Some(error.to_string());
                        log.push((false, format!("mcp {name}: {error}")));
                    }
                }
            }
            manager.servers.push(entry);
        }
        (manager, tools, log)
    }

    /// Snapshot for the panel.
    pub fn statuses(&self) -> Vec<McpServerStatus> {
        self.servers
            .iter()
            .map(|entry| McpServerStatus {
                name: entry.name.clone(),
                status: entry.status(),
                tools: entry
                    .tools
                    .iter()
                    .map(|tool| tool.name().to_string())
                    .collect(),
                error: entry.error.clone(),
            })
            .collect()
    }

    /// Stop a server: drop its client (killing a stdio child) and forget its
    /// tools. The caller unregisters the tools from the agent.
    pub async fn disable(&mut self, name: &str) -> Result<(), McpError> {
        let entry = self
            .servers
            .iter_mut()
            .find(|entry| entry.name == name)
            .ok_or_else(|| McpError::Protocol(format!("unknown MCP server `{name}`")))?;
        entry.client = None;
        entry.tools.clear();
        entry.error = None;
        Ok(())
    }

    /// Tools currently registered for a server (for wiring into the agent).
    pub fn tools_for(&self, name: &str) -> Vec<Arc<dyn Tool>> {
        self.servers
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.tools.clone())
            .unwrap_or_default()
    }

    /// Uninstall: remove the definition from its source file and drop the
    /// server. Returns the config file that was modified.
    pub async fn uninstall(&mut self, name: &str) -> Result<PathBuf, McpError> {
        let Some(index) = self.servers.iter().position(|entry| entry.name == name) else {
            return Err(McpError::Protocol(format!("unknown MCP server `{name}`")));
        };
        let removed = lmcode_mcp::config::remove_server(&self.cwd, name)?;
        let Some(path) = removed else {
            return Err(McpError::Protocol(format!(
                "`{name}` is not defined in an MCP config file"
            )));
        };
        self.servers.remove(index);
        Ok(path)
    }

    /// Install a server into the user config and connect it immediately.
    pub async fn install(
        &mut self,
        name: &str,
        config: &serde_json::Value,
    ) -> Result<(), McpError> {
        let home = lmcode_mcp::config::lmcode_home();
        lmcode_mcp::config::upsert_user_server(&home, name, config)?;
        let parsed: McpServerConfig =
            serde_json::from_value(config.clone()).map_err(|error| McpError::Config {
                path: "<recommended>".to_string(),
                message: error.to_string(),
            })?;
        let mut entry = ServerEntry {
            name: name.to_string(),
            config: parsed,
            client: None,
            tools: Vec::new(),
            error: None,
        };
        if let Some(existing) = self.servers.iter().position(|entry| entry.name == name) {
            self.servers.remove(existing);
        }
        match connect_entry(&mut entry).await {
            Ok(()) => {
                self.servers.push(entry);
                Ok(())
            }
            Err(error) => {
                entry.error = Some(error.to_string());
                self.servers.push(entry);
                Err(error)
            }
        }
    }

    /// (Re)connect a server and return the fresh tool adapters.
    pub async fn enable(&mut self, name: &str) -> Result<Vec<Arc<dyn Tool>>, McpError> {
        let entry = self
            .servers
            .iter_mut()
            .find(|entry| entry.name == name)
            .ok_or_else(|| McpError::Protocol(format!("unknown MCP server `{name}`")))?;
        match connect_entry(entry).await {
            Ok(()) => Ok(entry.tools.clone()),
            Err(error) => {
                entry.client = None;
                entry.tools.clear();
                entry.error = Some(error.to_string());
                Err(error)
            }
        }
    }
}

async fn connect_entry(entry: &mut ServerEntry) -> Result<(), McpError> {
    let client = Arc::new(Mutex::new(
        McpClient::connect(&entry.name, &entry.config).await?,
    ));
    {
        let mut guard = client.lock().await;
        guard.initialize().await?;
    }
    let definitions = {
        let mut guard = client.lock().await;
        guard.list_tools().await?
    };
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    for definition in definitions {
        let qualified = lmcode_mcp::qualify_tool_name(&entry.name, &definition.name);
        tools.push(Arc::new(McpToolAdapter::new(
            Arc::clone(&client),
            entry.name.clone(),
            qualified,
            definition,
        )));
    }
    entry.client = Some(client);
    entry.tools = tools;
    entry.error = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> ServerEntry {
        ServerEntry {
            name: name.to_string(),
            config: McpServerConfig {
                command: Some("definitely-not-a-real-command".to_string()),
                args: Vec::new(),
                env: Default::default(),
                url: None,
                headers: Default::default(),
                tool_timeout_ms: None,
                disabled: None,
            },
            client: None,
            tools: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn entry_status_transitions() {
        let mut server = entry("alpha");
        assert_eq!(server.status(), McpStatus::Disabled);
        server.error = Some("boom".to_string());
        assert_eq!(server.status(), McpStatus::Failed);
        // A live client wins over a stale error.
        server.client = Some(Arc::new(Mutex::new(McpClient::Http(
            // A never-contacted HTTP client is fine for state checks.
            lmcode_mcp::http::HttpMcpClient::new(
                "alpha",
                &McpServerConfig {
                    command: None,
                    args: Vec::new(),
                    env: Default::default(),
                    url: Some("http://127.0.0.1:9/mcp".to_string()),
                    headers: Default::default(),
                    tool_timeout_ms: None,
                    disabled: None,
                },
            )
            .unwrap(),
        ))));
        assert_eq!(server.status(), McpStatus::Connected);
    }

    #[tokio::test]
    async fn start_all_reports_spawn_failures_per_server() {
        // A config file with one bogus server, in an isolated home.
        let home = std::env::temp_dir().join(format!("lmcode-mcpmgr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".lmcode")).unwrap();
        std::fs::write(
            home.join(".lmcode/mcp.json"),
            r#"{"mcpServers":{"broken":{"command":"definitely-not-a-real-command-xyz"}}}"#,
        )
        .unwrap();
        let cwd = std::env::temp_dir().join(format!("lmcode-mcpmgr-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).unwrap();

        let servers =
            lmcode_mcp::config::load_servers_with_home(&cwd, &home.join(".lmcode")).unwrap();
        assert_eq!(servers.len(), 1);

        // Drive the manager against the bogus server directly.
        let mut manager = McpManager {
            cwd: cwd.clone(),
            servers: vec![entry("broken")],
        };
        let statuses = manager.statuses();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, McpStatus::Disabled);

        let error = match manager.enable("broken").await {
            Err(error) => error,
            Ok(_) => panic!("expected enable to fail"),
        };
        assert!(
            matches!(error, McpError::Spawn { .. } | McpError::Io(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(manager.statuses()[0].status, McpStatus::Failed);

        // Disabling a failed server resets it to the disabled state.
        manager.disable("broken").await.unwrap();
        assert_eq!(manager.statuses()[0].status, McpStatus::Disabled);

        // Unknown servers are rejected.
        assert!(manager.disable("nope").await.is_err());
        assert!(manager.enable("nope").await.is_err());

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
