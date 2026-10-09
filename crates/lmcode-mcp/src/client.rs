//! Stdio MCP client: spawns a server process and speaks newline-delimited
//! JSON-RPC 2.0 over its stdin/stdout.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::config::McpServerConfig;
use crate::error::McpError;

pub const DEFAULT_TOOL_TIMEOUT_MS: u64 = 60_000;
const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "lmcode";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// One tool advertised by an MCP server.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct McpToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Option<Value>,
}

/// A live connection to an MCP server over stdio.
pub struct StdioMcpClient {
    #[allow(dead_code)] // kept alive for `kill_on_drop`
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    tool_timeout: Duration,
    server_name: String,
}

impl StdioMcpClient {
    /// Spawn the server process and wire up its stdio pipes.
    pub async fn spawn(name: &str, config: &McpServerConfig) -> Result<Self, McpError> {
        let Some(executable) = config
            .command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        else {
            return Err(McpError::Spawn {
                server: name.to_string(),
                message: "stdio transport requires a `command`".to_string(),
            });
        };
        let mut command = Command::new(executable);
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &config.env {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|error| McpError::Spawn {
            server: name.to_string(),
            message: error.to_string(),
        })?;
        let stdin = child.stdin.take().ok_or_else(|| McpError::Spawn {
            server: name.to_string(),
            message: "no stdin pipe".to_string(),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| McpError::Spawn {
            server: name.to_string(),
            message: "no stdout pipe".to_string(),
        })?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            tool_timeout: Duration::from_millis(
                config.tool_timeout_ms.unwrap_or(DEFAULT_TOOL_TIMEOUT_MS),
            ),
            server_name: name.to_string(),
        })
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    /// Perform the MCP handshake.
    pub async fn initialize(&mut self) -> Result<Value, McpError> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION }
                }),
            )
            .await?;
        self.notify("notifications/initialized", json!({})).await?;
        Ok(result)
    }

    /// Fetch the server's tool list.
    pub async fn list_tools(&mut self) -> Result<Vec<McpToolDefinition>, McpError> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        serde_json::from_value(tools)
            .map_err(|error| McpError::Protocol(format!("invalid tools list: {error}")))
    }

    /// Invoke a tool and render its result to plain text.
    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, McpError> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await?;
        Ok(render_tool_result(&result))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;

        // Read until the matching response arrives; skip notifications and
        // responses to other (already-handled) requests.
        loop {
            let line = self.read_line().await?;
            let value: Value = serde_json::from_str(&line).map_err(|error| {
                McpError::Protocol(format!("invalid JSON from server: {error}"))
            })?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return extract_result(value, &self.server_name);
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        self.send_line(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn send_line(&mut self, message: &Value) -> Result<(), McpError> {
        let mut line = serde_json::to_string(message)
            .map_err(|error| McpError::Protocol(format!("failed to serialize request: {error}")))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| McpError::Io(error.to_string()))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| McpError::Io(error.to_string()))?;
        Ok(())
    }

    async fn read_line(&mut self) -> Result<String, McpError> {
        let mut line = String::new();
        match tokio::time::timeout(self.tool_timeout, self.stdout.read_line(&mut line)).await {
            Ok(Ok(0)) => Err(McpError::Disconnected(self.server_name.clone())),
            Ok(Ok(_)) => Ok(line),
            Ok(Err(error)) => Err(McpError::Io(error.to_string())),
            Err(_) => Err(McpError::Timeout {
                server: self.server_name.clone(),
                ms: self.tool_timeout.as_millis() as u64,
            }),
        }
    }
}

/// Extract `result` from a JSON-RPC response, mapping `error` to `McpError`.
pub(crate) fn extract_result(value: Value, server_name: &str) -> Result<Value, McpError> {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(McpError::Server {
            server: server_name.to_string(),
            message: message.to_string(),
        });
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

/// Render an MCP tool result payload into plain text.
pub(crate) fn render_tool_result(result: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                Some(other) => parts.push(format!("[{other} content]")),
                None => {}
            }
        }
    }
    let mut text = parts.join("\n");
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        if text.is_empty() {
            text = "tool reported an error".to_string();
        }
        text = format!("error: {text}");
    }
    if text.is_empty() {
        text = "(no output)".to_string();
    }
    text
}

/// Unified client over both transports.
pub enum McpClient {
    Stdio(Box<StdioMcpClient>),
    Http(crate::http::HttpMcpClient),
}

impl McpClient {
    /// Build the right transport from config: `url` → HTTP, else stdio.
    pub async fn connect(name: &str, config: &McpServerConfig) -> Result<Self, McpError> {
        let has_url = config
            .url
            .as_deref()
            .map(|url| !url.trim().is_empty())
            .unwrap_or(false);
        if has_url {
            Ok(Self::Http(crate::http::HttpMcpClient::new(name, config)?))
        } else {
            Ok(Self::Stdio(Box::new(
                StdioMcpClient::spawn(name, config).await?,
            )))
        }
    }

    pub fn server_name(&self) -> &str {
        match self {
            Self::Stdio(client) => client.server_name(),
            Self::Http(client) => client.server_name(),
        }
    }

    pub async fn initialize(&mut self) -> Result<Value, McpError> {
        match self {
            Self::Stdio(client) => client.initialize().await,
            Self::Http(client) => client.initialize().await,
        }
    }

    pub async fn list_tools(&mut self) -> Result<Vec<McpToolDefinition>, McpError> {
        match self {
            Self::Stdio(client) => client.list_tools().await,
            Self::Http(client) => client.list_tools().await,
        }
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, McpError> {
        match self {
            Self::Stdio(client) => client.call_tool(name, arguments).await,
            Self::Http(client) => client.call_tool(name, arguments).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_text_content_and_error_flag() {
        let ok = json!({"content": [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]});
        assert_eq!(render_tool_result(&ok), "hello\nworld");

        let error = json!({"content": [{"type": "text", "text": "boom"}], "isError": true});
        assert_eq!(render_tool_result(&error), "error: boom");

        let image = json!({"content": [{"type": "image", "data": "..."}]});
        assert_eq!(render_tool_result(&image), "[image content]");

        let empty = json!({"content": []});
        assert_eq!(render_tool_result(&empty), "(no output)");
    }
}
