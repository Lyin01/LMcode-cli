//! Language-server routing and client cache (mirrors `lsp/registry.ts`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::client::LspClient;

/// Command + language id for one file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LspLanguage {
    pub command: &'static [&'static str],
    pub language_id: &'static str,
}

/// Resolve the language server for a file path (mirrors `LANGUAGE_SERVERS`).
pub fn language_for_path(path: &str) -> Option<LspLanguage> {
    let (_, extension) = path.rsplit_once('.')?;
    let extension = format!(".{}", extension.to_ascii_lowercase());
    let language = match extension.as_str() {
        ".ts" => LspLanguage {
            command: &["typescript-language-server", "--stdio"],
            language_id: "typescript",
        },
        ".tsx" => LspLanguage {
            command: &["typescript-language-server", "--stdio"],
            language_id: "typescriptreact",
        },
        ".js" => LspLanguage {
            command: &["typescript-language-server", "--stdio"],
            language_id: "javascript",
        },
        ".jsx" => LspLanguage {
            command: &["typescript-language-server", "--stdio"],
            language_id: "javascriptreact",
        },
        ".py" => LspLanguage {
            command: &["pyright-langserver", "--stdio"],
            language_id: "python",
        },
        ".rs" => LspLanguage {
            command: &["rust-analyzer"],
            language_id: "rust",
        },
        ".go" => LspLanguage {
            command: &["gopls"],
            language_id: "go",
        },
        _ => return None,
    };
    Some(language)
}

/// Cache of running clients keyed by workspace + command.
#[derive(Default)]
pub struct LspRegistry {
    clients: Mutex<HashMap<String, Arc<Mutex<LspClient>>>>,
}

impl LspRegistry {
    /// Get or start the client for a path; `None` for unsupported files.
    pub async fn get_client(
        &self,
        path: &str,
        workspace_root: &Path,
    ) -> Result<Option<Arc<Mutex<LspClient>>>, String> {
        let Some(language) = language_for_path(path) else {
            return Ok(None);
        };
        let key = format!(
            "{}\0{}",
            workspace_root.display(),
            language.command.join(" ")
        );
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get(&key) {
            return Ok(Some(Arc::clone(client)));
        }
        let client =
            LspClient::start(language.command, workspace_root, language.language_id).await?;
        let handle = Arc::new(Mutex::new(client));
        clients.insert(key, Arc::clone(&handle));
        Ok(Some(handle))
    }

    /// Stop every running client (process shutdown).
    pub async fn stop_all(&self) {
        let clients: Vec<Arc<Mutex<LspClient>>> = {
            let mut guard = self.clients.lock().await;
            guard.drain().map(|(_, client)| client).collect()
        };
        for client in clients {
            client.lock().await.stop().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_supported_extensions() {
        assert_eq!(
            language_for_path("a/b.ts").unwrap().language_id,
            "typescript"
        );
        assert_eq!(
            language_for_path("x.tsx").unwrap().language_id,
            "typescriptreact"
        );
        assert_eq!(language_for_path("x.js").unwrap().language_id, "javascript");
        assert_eq!(language_for_path("x.py").unwrap().language_id, "python");
        assert_eq!(
            language_for_path("x.rs").unwrap().command,
            &["rust-analyzer"]
        );
        assert_eq!(language_for_path("x.go").unwrap().language_id, "go");
        // Case-insensitive extension.
        assert_eq!(language_for_path("x.RS").unwrap().language_id, "rust");
        assert!(language_for_path("x.txt").is_none());
        assert!(language_for_path("no-extension").is_none());
    }
}
