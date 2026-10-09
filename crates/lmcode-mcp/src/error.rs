//! Errors produced by the MCP client layer.

/// Errors produced while talking to MCP servers.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("failed to start MCP server `{server}`: {message}")]
    Spawn { server: String, message: String },
    #[error("MCP server `{server}` returned an error: {message}")]
    Server { server: String, message: String },
    #[error("MCP server `{0}` disconnected")]
    Disconnected(String),
    #[error("MCP server `{server}` timed out after {ms} ms")]
    Timeout { server: String, ms: u64 },
    #[error("MCP protocol error: {0}")]
    Protocol(String),
    #[error("MCP io error: {0}")]
    Io(String),
    #[error("failed to read MCP config `{path}`: {message}")]
    Config { path: String, message: String },
}
