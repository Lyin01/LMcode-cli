//! MCP tool adapter — exposes remote MCP tools as local agent tools.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use lmcode_mcp::{McpClient, McpToolDefinition};
use serde_json::json;
use tokio::sync::Mutex;

use super::Tool;

/// Wraps one MCP tool behind a shared server connection.
pub struct McpToolAdapter {
    client: Arc<Mutex<McpClient>>,
    server_name: String,
    qualified_name: String,
    tool: McpToolDefinition,
}

impl McpToolAdapter {
    pub fn new(
        client: Arc<Mutex<McpClient>>,
        server_name: String,
        qualified_name: String,
        tool: McpToolDefinition,
    ) -> Self {
        Self {
            client,
            server_name,
            qualified_name,
            tool,
        }
    }
}

#[async_trait]
impl Tool for McpToolAdapter {
    fn name(&self) -> &str {
        &self.qualified_name
    }

    fn description(&self) -> &str {
        self.tool
            .description
            .as_deref()
            .unwrap_or("MCP tool (no description provided by the server)")
    }

    fn parameters_schema(&self) -> serde_json::Value {
        self.tool
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({"type": "object"}))
    }

    // MCP tools keep the default approval requirement: a remote server can
    // perform arbitrary operations, so the user confirms each call.

    async fn execute(&self, arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let mut client = self.client.lock().await;
        client
            .call_tool(&self.tool.name, arguments.clone())
            .await
            .map_err(|error| format!("[{0}] {error}", self.server_name))
    }
}
