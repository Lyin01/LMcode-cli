//! Language Server Protocol support (mirrors `packages/agent-core/src/lsp`).

pub mod client;
pub mod registry;

pub use client::{LspClient, LspDiagnostic, LspLocation};
pub use registry::{LspLanguage, LspRegistry, language_for_path};
