//! Minimal LSP client over stdio JSON-RPC (mirrors `lsp/client.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(5);
const SEVERITY_LABELS: [&str; 4] = ["Error", "Warning", "Information", "Hint"];

/// One diagnostic (severity + message + position).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspDiagnostic {
    pub severity: &'static str,
    pub message: String,
    pub line: u64,
    pub character: u64,
}

/// One location (definition / reference hit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspLocation {
    pub path: String,
    pub line: u64,
    pub character: u64,
}

/// A running language server process.
pub struct LspClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Option<Child>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>>,
    open_documents: HashMap<String, u64>,
    root: PathBuf,
    language_id: String,
}

impl LspClient {
    /// Spawn the server, run the `initialize` handshake, and return a client.
    pub async fn start(command: &[&str], root: &Path, language_id: &str) -> Result<Self, String> {
        let (program, args) = command.split_first().ok_or("empty LSP command")?;
        let mut child = Command::new(program)
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to start `{program}`: {error}"))?;
        let stdin = child.stdin.take().ok_or("LSP server has no stdin")?;
        let stdout = child.stdout.take().ok_or("LSP server has no stdout")?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(stdout, Arc::clone(&pending), Arc::clone(&diagnostics));

        let mut client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Some(child),
            next_id: AtomicU64::new(0),
            pending,
            diagnostics,
            open_documents: HashMap::new(),
            root: root.to_path_buf(),
            language_id: language_id.to_string(),
        };
        client
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "rootUri": path_to_uri(root),
                    "capabilities": {}
                }),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    /// Open (or refresh) a document so results reflect unsaved state.
    pub async fn did_open(&mut self, path: &Path, content: &str) -> Result<(), String> {
        let uri = path_to_uri(path);
        let version = self.open_documents.entry(uri.clone()).or_insert(0);
        if *version == 0 {
            *version = 1;
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": self.language_id,
                        "version": 1,
                        "text": content
                    }
                }),
            )
            .await
        } else {
            *version += 1;
            let next = *version;
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": next },
                    "contentChanges": [{ "text": content }]
                }),
            )
            .await
        }
    }

    /// All references to the symbol at a position (0-based).
    pub async fn references(
        &mut self,
        path: &Path,
        line: u64,
        character: u64,
        include_declaration: bool,
    ) -> Result<Vec<LspLocation>, String> {
        let result = self
            .request(
                "textDocument/references",
                json!({
                    "textDocument": { "uri": path_to_uri(path) },
                    "position": { "line": line, "character": character },
                    "context": { "includeDeclaration": include_declaration }
                }),
            )
            .await?;
        Ok(parse_locations(&result))
    }

    /// The definition site of the symbol at a position (0-based).
    pub async fn definition(
        &mut self,
        path: &Path,
        line: u64,
        character: u64,
    ) -> Result<Vec<LspLocation>, String> {
        let result = self
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": path_to_uri(path) },
                    "position": { "line": line, "character": character }
                }),
            )
            .await?;
        Ok(parse_locations(&result))
    }

    /// Diagnostics for a file, waiting briefly for the server to publish.
    pub async fn diagnostics(&mut self, path: &Path) -> Result<Vec<LspDiagnostic>, String> {
        let uri = path_to_uri(path);
        let deadline = std::time::Instant::now() + DIAGNOSTICS_TIMEOUT;
        loop {
            if let Some(items) = self.diagnostics.lock().await.get(&uri) {
                return Ok(items.clone());
            }
            if std::time::Instant::now() >= deadline {
                return Ok(Vec::new());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Graceful shutdown, then a hard kill if the server does not exit.
    pub async fn stop(&mut self) {
        let _ = self.notify("shutdown", json!({})).await;
        let _ = self.notify("exit", json!({})).await;
        if let Some(child) = &mut self.child
            && tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
        {
            let _ = child.kill().await;
        }
    }

    /// Workspace root the server was started for.
    pub fn root(&self) -> &Path {
        &self.root
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        match tokio::time::timeout(DEFAULT_REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(message)) => {
                if let Some(error) = message.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string();
                    return Err(text);
                }
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok(Err(_)) => Err("LSP server connection closed".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("LSP request `{method}` timed out"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let payload = serde_json::to_string(message).map_err(|error| error.to_string())?;
        let frame = format!("Content-Length: {}\r\n\r\n{payload}", payload.len());
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(frame.as_bytes())
            .await
            .map_err(|error| format!("failed to write to LSP server: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush LSP server: {error}"))
    }
}

/// Reader loop: frames messages, resolves pending requests, collects
/// diagnostics notifications. On EOF every pending request fails
/// immediately so callers do not wait out the full timeout when the
/// server exits.
fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>>,
) {
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout);
        loop {
            let mut content_length: Option<usize> = None;
            loop {
                let mut line = String::new();
                let Ok(read) = reader.read_line(&mut line).await else {
                    fail_pending(&pending).await;
                    return;
                };
                if read == 0 {
                    fail_pending(&pending).await;
                    return;
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                    content_length = value.trim().parse().ok();
                }
            }
            let Some(length) = content_length else {
                fail_pending(&pending).await;
                return;
            };
            let mut buffer = vec![0u8; length];
            if reader.read_exact(&mut buffer).await.is_err() {
                fail_pending(&pending).await;
                return;
            }
            let Ok(message) = serde_json::from_slice::<Value>(&buffer) else {
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(sender) = pending.lock().await.remove(&id) {
                    let _ = sender.send(message);
                }
                continue;
            }
            if message.get("method").and_then(Value::as_str)
                == Some("textDocument/publishDiagnostics")
                && let Some(params) = message.get("params")
            {
                let uri = params
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let items = params
                    .get("diagnostics")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let parsed: Vec<LspDiagnostic> = items.iter().map(parse_diagnostic).collect();
                diagnostics.lock().await.insert(uri, parsed);
            }
        }
    });
}

/// Fail every pending request (used when the server connection ends).
async fn fail_pending(pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>) {
    let mut guard = pending.lock().await;
    for (_, sender) in guard.drain() {
        let _ = sender.send(json!({
            "error": { "message": "LSP server exited unexpectedly" }
        }));
    }
}

/// Parse a `Location` / `LocationLink` array (or single object).
fn parse_locations(result: &Value) -> Vec<LspLocation> {
    let items: Vec<&Value> = match result {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![result],
        _ => Vec::new(),
    };
    let mut locations = Vec::new();
    for item in items {
        let (uri, range) = if item.get("targetUri").is_some() {
            (
                item.get("targetUri"),
                item.get("targetSelectionRange")
                    .or_else(|| item.get("targetRange")),
            )
        } else {
            (item.get("uri"), item.get("range"))
        };
        let Some(uri) = uri.and_then(Value::as_str) else {
            continue;
        };
        let Some(range) = range else {
            continue;
        };
        let start = &range["start"];
        locations.push(LspLocation {
            path: uri_to_path(uri),
            line: start["line"].as_u64().unwrap_or(0),
            character: start["character"].as_u64().unwrap_or(0),
        });
    }
    locations
}

fn parse_diagnostic(item: &Value) -> LspDiagnostic {
    let severity = item.get("severity").and_then(Value::as_u64).unwrap_or(1);
    let label = SEVERITY_LABELS
        .get((severity.saturating_sub(1)) as usize)
        .copied()
        .unwrap_or("Error");
    let start = &item["range"]["start"];
    LspDiagnostic {
        severity: label,
        message: item
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        line: start["line"].as_u64().unwrap_or(0),
        character: start["character"].as_u64().unwrap_or(0),
    }
}

/// `file://` URI for a path (Windows drive letters become `/C:/…`).
pub fn path_to_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    let encoded: String = normalized
        .chars()
        .map(|ch| match ch {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            other => other.to_string(),
        })
        .collect();
    format!("file://{encoded}")
}

/// Best-effort URI → path conversion.
pub fn uri_to_path(uri: &str) -> String {
    let stripped = uri.strip_prefix("file://").unwrap_or(uri);
    let mut path = stripped.to_string();
    // Windows drive form: /C:/x → C:/x
    if path.len() >= 3 && path.starts_with('/') && path.as_bytes()[2] == b':' {
        path.remove(0);
    }
    path.replace("%20", " ")
        .replace("%23", "#")
        .replace("%3F", "?")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_round_trip_for_common_paths() {
        assert_eq!(
            path_to_uri(Path::new("/tmp/a b.ts")),
            "file:///tmp/a%20b.ts"
        );
        assert_eq!(uri_to_path("file:///tmp/a%20b.ts"), "/tmp/a b.ts");
        // Windows drive form.
        assert_eq!(path_to_uri(Path::new("C:/x/y.rs")), "file:///C:/x/y.rs");
        assert_eq!(uri_to_path("file:///C:/x/y.rs"), "C:/x/y.rs");
    }

    #[test]
    fn parses_location_shapes() {
        let array = json!([
            { "uri": "file:///a.ts", "range": { "start": { "line": 1, "character": 2 }, "end": {} } }
        ]);
        let locations = parse_locations(&array);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].path, "/a.ts");
        assert_eq!((locations[0].line, locations[0].character), (1, 2));

        // LocationLink shape.
        let link = json!({
            "targetUri": "file:///b.rs",
            "targetSelectionRange": { "start": { "line": 3, "character": 4 } }
        });
        let locations = parse_locations(&link);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].path, "/b.rs");
        assert_eq!((locations[0].line, locations[0].character), (3, 4));

        assert!(parse_locations(&Value::Null).is_empty());
    }

    #[test]
    fn parses_diagnostics_with_severity_labels() {
        let item = json!({
            "severity": 2,
            "message": "unused variable",
            "range": { "start": { "line": 5, "character": 6 } }
        });
        let diagnostic = parse_diagnostic(&item);
        assert_eq!(diagnostic.severity, "Warning");
        assert_eq!(diagnostic.message, "unused variable");
        assert_eq!((diagnostic.line, diagnostic.character), (5, 6));
        // Missing severity defaults to Error.
        let diagnostic = parse_diagnostic(&json!({ "message": "boom" }));
        assert_eq!(diagnostic.severity, "Error");
    }

    #[tokio::test]
    async fn handshakes_with_a_mock_language_server() {
        // A tiny Python LSP server: answers `initialize` and
        // `textDocument/definition` and publishes one diagnostic.
        let script = r#"
import json, sys

def read_message():
    length = None
    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        line = line.strip()
        if line == "":
            break
        if line.lower().startswith("content-length:"):
            length = int(line.split(":")[1].strip())
    if length is None:
        return None
    return json.loads(sys.stdin.read(length))

def send(message):
    payload = json.dumps(message)
    sys.stdout.write(f"Content-Length: {len(payload)}\r\n\r\n{payload}")
    sys.stdout.flush()

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {}}})
    elif method == "initialized":
        pass
    elif method == "textDocument/didOpen":
        uri = message["params"]["textDocument"]["uri"]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {
            "uri": uri,
            "diagnostics": [{"severity": 1, "message": "mock error", "range": {"start": {"line": 0, "character": 0}}}]
        }})
    elif method == "textDocument/definition":
        send({"jsonrpc": "2.0", "id": message["id"], "result": [
            {"uri": "file:///mock/target.rs", "range": {"start": {"line": 7, "character": 8}}}
        ]})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
    elif method == "exit":
        break
"#;
        let dir = std::env::temp_dir().join(format!("lmcode-lsp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("mock_lsp.py");
        std::fs::write(&script_path, script).unwrap();

        let script_arg = script_path.to_string_lossy().to_string();
        let mut client = LspClient::start(&["python", &script_arg], &dir, "rust")
            .await
            .expect("handshake should succeed");

        let source = dir.join("sample.rs");
        client
            .did_open(&source, "fn main() {}")
            .await
            .expect("didOpen should succeed");

        let locations = client
            .definition(&source, 0, 0)
            .await
            .expect("definition should succeed");
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].path, "/mock/target.rs");
        assert_eq!((locations[0].line, locations[0].character), (7, 8));

        let diagnostics = client
            .diagnostics(&source)
            .await
            .expect("diagnostics should succeed");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message, "mock error");
        assert_eq!(diagnostics[0].severity, "Error");

        client.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
