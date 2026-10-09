//! MCP client — Rust port of `packages/agent-core/src/mcp`.
//!
//! Implements the stdio transport (newline-delimited JSON-RPC 2.0):
//! `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
//! HTTP transport, OAuth, and the `/mcp` panel land in later batches.

pub mod client;
pub mod config;
pub mod error;
pub mod http;
pub mod naming;

pub use client::{McpClient, McpToolDefinition, StdioMcpClient};
pub use config::{McpServerConfig, load_servers};
pub use error::McpError;
pub use http::HttpMcpClient;
pub use naming::{is_mcp_tool_name, qualify_tool_name, sanitize_name_part};
