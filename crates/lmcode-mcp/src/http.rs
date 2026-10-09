//! Streamable HTTP transport for MCP.
//!
//! POSTs single JSON-RPC messages to the server URL; responses are either
//! `application/json` (single response) or `text/event-stream` (SSE carrying
//! the response). Session continuity uses the `Mcp-Session-Id` header issued
//! during `initialize`, mirroring the TS client's transport behavior.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::client::{McpToolDefinition, extract_result};
use crate::config::McpServerConfig;
use crate::error::McpError;

pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "lmcode";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const SESSION_HEADER: &str = "mcp-session-id";

/// HTTP connection state for one MCP server.
pub struct HttpMcpClient {
    server_name: String,
    url: String,
    headers: HashMap<String, String>,
    client: reqwest::Client,
    session_id: Option<String>,
    next_id: u64,
    timeout: Duration,
}

impl HttpMcpClient {
    pub fn new(name: &str, config: &McpServerConfig) -> Result<Self, McpError> {
        let Some(url) = config.url.clone().filter(|url| !url.trim().is_empty()) else {
            return Err(McpError::Config {
                path: name.to_string(),
                message: "http transport requires a `url`".to_string(),
            });
        };
        Ok(Self {
            server_name: name.to_string(),
            url,
            headers: config.headers.clone(),
            client: reqwest::Client::new(),
            session_id: None,
            next_id: 1,
            timeout: Duration::from_millis(config.tool_timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)),
        })
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
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
        Ok(crate::client::render_tool_result(&result))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let response = self.post(&body).await?;

        if let Some(session) = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
        {
            self.session_id = Some(session.to_string());
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        if content_type.contains("text/event-stream") {
            parse_sse_response(response, id, &self.server_name).await
        } else {
            let value: Value = response
                .json()
                .await
                .map_err(|error| McpError::Protocol(format!("invalid JSON response: {error}")))?;
            extract_result(value, &self.server_name)
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        // Notifications get 202 Accepted with no body; errors here are fatal
        // for the handshake, so surface them.
        let _ = self.post(&body).await?;
        Ok(())
    }

    async fn post(&self, body: &Value) -> Result<reqwest::Response, McpError> {
        let mut request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(body);
        if let Some(session) = &self.session_id {
            request = request.header(SESSION_HEADER, session);
        }
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }

        let response = match tokio::time::timeout(self.timeout, request.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(McpError::Io(error.to_string())),
            Err(_) => {
                return Err(McpError::Timeout {
                    server: self.server_name.clone(),
                    ms: self.timeout.as_millis() as u64,
                });
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(McpError::Server {
                server: self.server_name.clone(),
                message: format!("HTTP {}: {}", status.as_u16(), body.trim()),
            });
        }
        Ok(response)
    }
}

/// Read an SSE response stream until the JSON-RPC response with `id` arrives.
///
/// A trimmed reader: it only needs `data:` lines from a short-lived response
/// stream (notifications and other ids are skipped).
async fn parse_sse_response(
    response: reqwest::Response,
    id: u64,
    server_name: &str,
) -> Result<Value, McpError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| McpError::Io(error.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim_end_matches('\r').to_string();
            buffer.drain(..=newline);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return extract_result(value, server_name);
            }
        }
    }
    Err(McpError::Disconnected(server_name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_config_requires_url() {
        let config = McpServerConfig {
            command: None,
            args: vec![],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            tool_timeout_ms: None,
            disabled: None,
        };
        assert!(HttpMcpClient::new("no-url", &config).is_err());
    }

    #[test]
    fn http_config_accepts_url_and_headers() {
        let config = McpServerConfig {
            command: None,
            args: vec![],
            env: Default::default(),
            url: Some("https://example.com/mcp".to_string()),
            headers: HashMap::from([("x-api-key".to_string(), "k".to_string())]),
            tool_timeout_ms: Some(5_000),
            disabled: None,
        };
        let client = HttpMcpClient::new("http-server", &config).unwrap();
        assert_eq!(client.server_name(), "http-server");
        assert_eq!(client.session_id(), None);
        assert_eq!(client.timeout.as_millis(), 5_000);
    }
}
