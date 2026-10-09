//! MCP OAuth persistence, the localhost callback, and the authenticate-tool
//! result the model sees.
//!
//! This is the part `packages/agent-core/src/mcp/oauth` and `auth-tool.ts`
//! pin down with tests: store keys, token files, the callback listener, and
//! the authorization-URL update. Discovery and the token-endpoint exchange
//! still belong to the authorization server client, which is not in this module.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};

const PASSIVE_REDIRECT_URI: &str = "http://127.0.0.1:3118/callback";
const TOKENS_SUFFIX: &str = "-tokens.json";
const CLIENT_SUFFIX: &str = "-client.json";

/// Custom tool update the desktop renders as an OAuth authorization link.
pub const AUTHORIZATION_URL_UPDATE: &str = "mcp.oauth.authorization_url";

const SUCCESS_HTML: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Authorized</title></head>",
    "<body style=\"font-family:system-ui,sans-serif;padding:2rem;\">",
    "<h1>Sign-in complete</h1>",
    "<p>You can close this tab and return to lmcode.</p>",
    "</body></html>"
);

const ERROR_HTML: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>OAuth error</title></head>",
    "<body style=\"font-family:system-ui,sans-serif;padding:2rem;\">",
    "<h1>Sign-in failed</h1>",
    "<p>The authorization server reported an error. Return to lmcode for details.</p>",
    "</body></html>"
);

/// Turn a server name into a single path segment.
///
/// `../../etc/passwd` becomes `passwd`. Characters outside `[A-Za-z0-9_-]`
/// become `_`, and runs collapse. An empty result is rejected.
pub fn sanitize_store_key(name: &str) -> Result<String, String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut replaced = String::new();
    for character in base.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            replaced.push(character);
        } else {
            replaced.push('_');
        }
    }
    let mut collapsed = String::new();
    let mut previous_underscore = false;
    for character in replaced.chars() {
        if character == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        collapsed.push(character);
    }
    if collapsed.is_empty() || collapsed.starts_with('.') {
        return Err(format!("Invalid MCP OAuth store key: \"{name}\""));
    }
    Ok(collapsed)
}

/// Strip the fragment. The rest of the URL is the credential resource identity.
pub fn canonical_mcp_oauth_resource(server_url: &str) -> String {
    match server_url.split_once('#') {
        Some((before, _)) => before.to_string(),
        None => server_url.to_string(),
    }
}

/// File-name prefix that isolates one server name on one URL.
pub fn mcp_oauth_store_key(server_name: &str, server_url: &str) -> Result<String, String> {
    let safe_name = sanitize_store_key(server_name)?;
    let resource = canonical_mcp_oauth_resource(server_url);
    let mut hasher = Sha256::new();
    hasher.update(server_name.as_bytes());
    hasher.update([0u8]);
    hasher.update(resource.as_bytes());
    let digest = hasher.finalize();
    let hex = hex_encode(&digest);
    Ok(format!("{safe_name}-{}", &hex[..24]))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// JSON files under `<home>/credentials/mcp`, written by rename so a crash
/// cannot leave a half-written token.
#[derive(Debug, Clone)]
pub struct JsonFileStore {
    dir: PathBuf,
}

impl JsonFileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn read(&self, file: &str) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(self.dir.join(file)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn write(&self, file: &str, data: &serde_json::Value) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|error| error.to_string())?;
        restrict_dir(&self.dir);
        let target = self.dir.join(file);
        let tmp_name = format!("{}.tmp.{}.{:08x}", file, std::process::id(), random_u64());
        let tmp = self.dir.join(tmp_name);
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(data).map_err(|error| error.to_string())?
        );
        std::fs::write(&tmp, body).map_err(|error| error.to_string())?;
        restrict_file(&tmp);
        if let Err(error) = replace_file(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        restrict_file(&target);
        Ok(())
    }

    pub fn remove(&self, file: &str) -> Result<(), String> {
        match std::fs::remove_file(self.dir.join(file)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn replace_file(tmp: &Path, target: &Path) -> Result<(), String> {
    if cfg!(windows) && target.exists() {
        std::fs::remove_file(target).map_err(|error| error.to_string())?;
    }
    std::fs::rename(tmp, target).map_err(|error| error.to_string())
}

fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn random_u64() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let tick = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ tick.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

fn random_hex(bytes: usize) -> String {
    let mut out = String::new();
    while out.len() < bytes * 2 {
        out.push_str(&format!("{:016x}", random_u64()));
    }
    out.truncate(bytes * 2);
    out
}

/// One server URL's tokens, registered client, and in-memory flow state.
pub struct McpOAuthClientProvider {
    pub store_key: String,
    server_url: String,
    store: JsonFileStore,
    client_label: String,
    redirect_url: Option<String>,
    last_authorization_url: Option<String>,
    state: Option<String>,
    code_verifier: Option<String>,
}

impl McpOAuthClientProvider {
    pub fn new(server_name: &str, server_url: &str, store: JsonFileStore) -> Result<Self, String> {
        let server_url = canonical_mcp_oauth_resource(server_url);
        Ok(Self {
            store_key: mcp_oauth_store_key(server_name, &server_url)?,
            client_label: format!("lmcode ({server_name})"),
            server_url,
            store,
            redirect_url: None,
            last_authorization_url: None,
            state: None,
            code_verifier: None,
        })
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    pub fn set_redirect_url(&mut self, url: impl Into<String>) {
        self.redirect_url = Some(url.into());
    }

    /// URL captured from the latest authorization redirect. Taking it clears it.
    pub fn take_authorization_url(&mut self) -> Option<String> {
        self.last_authorization_url.take()
    }

    pub fn redirect_to_authorization(&mut self, url: impl Into<String>) {
        self.last_authorization_url = Some(url.into());
    }

    pub fn expected_state(&self) -> Option<&str> {
        self.state.as_deref()
    }

    pub fn state(&mut self) -> String {
        if self.state.is_none() {
            self.state = Some(random_hex(16));
        }
        self.state.clone().unwrap_or_default()
    }

    pub fn redirect_url(&self) -> String {
        if let Some(url) = &self.redirect_url {
            return url.clone();
        }
        self.registered_redirect()
            .unwrap_or_else(|| PASSIVE_REDIRECT_URI.to_string())
    }

    pub fn client_metadata(&self) -> ClientMetadata {
        ClientMetadata {
            redirect_uris: vec![self.redirect_url()],
            token_endpoint_auth_method: "none",
            grant_types: vec!["authorization_code", "refresh_token"],
            response_types: vec!["code"],
            client_name: self.client_label.clone(),
        }
    }

    pub fn save_client_information(&self, info: &serde_json::Value) -> Result<(), String> {
        self.store
            .write(&format!("{}{CLIENT_SUFFIX}", self.store_key), info)
    }

    pub fn tokens(&self) -> Option<serde_json::Value> {
        self.store
            .read(&format!("{}{TOKENS_SUFFIX}", self.store_key))
    }

    pub fn save_tokens(&self, tokens: &serde_json::Value) -> Result<(), String> {
        self.store
            .write(&format!("{}{TOKENS_SUFFIX}", self.store_key), tokens)
    }

    pub fn save_code_verifier(&mut self, verifier: impl Into<String>) {
        self.code_verifier = Some(verifier.into());
    }

    pub fn code_verifier(&self) -> Result<&str, String> {
        self.code_verifier
            .as_deref()
            .ok_or_else(|| "McpOAuthClientProvider: PKCE code verifier not initialized".to_string())
    }

    fn registered_redirect(&self) -> Option<String> {
        let info = self
            .store
            .read(&format!("{}{CLIENT_SUFFIX}", self.store_key))?;
        info.get("redirect_uris")?
            .as_array()?
            .first()?
            .as_str()
            .map(str::to_string)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientMetadata {
    pub redirect_uris: Vec<String>,
    pub token_endpoint_auth_method: &'static str,
    pub grant_types: Vec<&'static str>,
    pub response_types: Vec<&'static str>,
    pub client_name: String,
}

/// Shared store the connection manager asks "does this URL already have tokens?".
#[derive(Debug, Clone)]
pub struct McpOAuthService {
    store: JsonFileStore,
}

impl McpOAuthService {
    pub fn new(store: JsonFileStore) -> Self {
        Self { store }
    }

    pub fn get_provider(
        &self,
        server_name: &str,
        server_url: &str,
    ) -> Result<McpOAuthClientProvider, String> {
        McpOAuthClientProvider::new(server_name, server_url, self.store.clone())
    }

    pub fn has_tokens(&self, server_name: &str, server_url: &str) -> bool {
        self.get_provider(server_name, server_url)
            .ok()
            .and_then(|provider| provider.tokens())
            .is_some()
    }
}

/// Code (and optional state) from the browser redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackResult {
    pub code: String,
    pub state: Option<String>,
}

struct SharedCallback {
    outcome: Mutex<Option<Result<CallbackResult, String>>>,
    notify: Notify,
}

/// One-shot `http://127.0.0.1:<port>/callback` listener.
pub struct CallbackServer {
    redirect_uri: String,
    shared: Arc<SharedCallback>,
    task: tokio::task::JoinHandle<()>,
}

impl CallbackServer {
    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// Resolves with the first callback, including one that arrived before this wait.
    pub async fn wait_for_code(&self, timeout_ms: u64) -> Result<CallbackResult, String> {
        let wait = async {
            loop {
                if let Some(outcome) = self.shared.outcome.lock().await.clone() {
                    return outcome;
                }
                self.shared.notify.notified().await;
            }
        };
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait).await {
            Ok(result) => result,
            Err(_) => Err("OAuth callback timed out".to_string()),
        }
    }

    pub async fn close(&self) {
        self.task.abort();
    }
}

pub async fn start_callback_server() -> Result<CallbackServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let shared = Arc::new(SharedCallback {
        outcome: Mutex::new(None),
        notify: Notify::new(),
    });
    let task_shared = Arc::clone(&shared);
    let task = tokio::spawn(async move {
        loop {
            let accepted = listener.accept().await;
            let Ok((mut socket, _)) = accepted else {
                break;
            };
            let shared = Arc::clone(&task_shared);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let Ok(Ok(n)) =
                    tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut buf))
                        .await
                else {
                    return;
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let (status, body, outcome) = handle_callback(&request);
                let reason = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    _ => "Not Found",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
                if let Some(outcome) = outcome {
                    let mut slot = shared.outcome.lock().await;
                    if slot.is_none() {
                        *slot = Some(outcome);
                        drop(slot);
                        shared.notify.notify_one();
                    }
                }
            });
        }
    });
    Ok(CallbackServer {
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
        shared,
        task,
    })
}

fn handle_callback(request: &str) -> (u16, String, Option<Result<CallbackResult, String>>) {
    let line = request.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        return (404, String::new(), None);
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    if path != "/callback" {
        return (404, String::new(), None);
    }
    let params = parse_query(query);
    if let Some(error) = params.get("error") {
        let description = params.get("error_description").cloned().unwrap_or_default();
        let message = if description.is_empty() {
            format!("OAuth error: {error}")
        } else {
            format!("OAuth error: {error} — {description}")
        };
        return (400, ERROR_HTML.to_string(), Some(Err(message)));
    }
    match params.get("code").filter(|code| !code.is_empty()) {
        Some(code) => (
            200,
            SUCCESS_HTML.to_string(),
            Some(Ok(CallbackResult {
                code: code.clone(),
                state: params.get("state").cloned(),
            })),
        ),
        None => (
            400,
            ERROR_HTML.to_string(),
            Some(Err("OAuth callback missing authorization code".to_string())),
        ),
    }
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if query.is_empty() {
        return params;
    }
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(percent_decode(key), percent_decode(value));
    }
    params
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What `beginAuthorization` produced for the synthetic authenticate tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    Redirect { authorization_url: String },
}

/// `AlreadyAuthorized` reconnects. Any other failure is shown to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginError {
    AlreadyAuthorized,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthUpdate {
    Status(String),
    AuthorizationUrl {
        server_name: String,
        authorization_url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthOutput {
    pub is_error: bool,
    pub output: String,
}

/// Run the synthetic `authenticate` tool against an OAuth flow.
///
/// `begin` is the discovery step. On a redirect, `complete` waits for the
/// callback and exchanges the code. `reconnect` runs after tokens exist.
pub async fn run_mcp_authenticate<B, BF, C, CF, R, RF>(
    server_name: &str,
    begin: B,
    complete: C,
    reconnect: R,
    updates: &mut Vec<AuthUpdate>,
) -> AuthOutput
where
    B: FnOnce() -> BF,
    BF: Future<Output = Result<BeginOutcome, BeginError>>,
    C: FnOnce() -> CF,
    CF: Future<Output = Result<(), String>>,
    R: FnOnce() -> RF,
    RF: Future<Output = Result<(), String>>,
{
    updates.push(AuthUpdate::Status(format!(
        "Discovering OAuth metadata for {server_name}…"
    )));
    match begin().await {
        Err(BeginError::AlreadyAuthorized) => {
            updates.push(AuthUpdate::Status(format!(
                "Already authorized; reconnecting {server_name}…"
            )));
            match reconnect().await {
                Ok(()) => AuthOutput {
                    is_error: false,
                    output: format!(
                        "MCP server \"{server_name}\" already had valid OAuth credentials. Reconnected; real tools are available now."
                    ),
                },
                Err(error) => auth_error(server_name, &error, None),
            }
        }
        Err(BeginError::Failed(message)) => auth_error(server_name, &message, None),
        Ok(BeginOutcome::Redirect { authorization_url }) => {
            updates.push(AuthUpdate::AuthorizationUrl {
                server_name: server_name.to_string(),
                authorization_url: authorization_url.clone(),
            });
            updates.push(AuthUpdate::Status(format!(
                "Open this URL in your browser to authorize \"{server_name}\":\n\n{authorization_url}\n\nWaiting for the OAuth callback (timeout 15 min). If you cancel, call this tool again to restart the flow."
            )));
            if let Err(error) = complete().await {
                return auth_error(server_name, &error, Some(&authorization_url));
            }
            updates.push(AuthUpdate::Status(format!(
                "Authorized — reconnecting {server_name}…"
            )));
            if let Err(error) = reconnect().await {
                return auth_error(server_name, &error, None);
            }
            AuthOutput {
                is_error: false,
                output: format!(
                    "MCP server \"{server_name}\" authenticated successfully. The real MCP tools have replaced this synthetic authenticate tool."
                ),
            }
        }
    }
}

fn auth_error(server_name: &str, message: &str, authorization_url: Option<&str>) -> AuthOutput {
    let suffix = match authorization_url {
        Some(url) => {
            format!("\n\nAuthorization URL (still valid if the listener has not timed out): {url}")
        }
        None => String::new(),
    };
    AuthOutput {
        is_error: true,
        output: format!(
            "OAuth flow for MCP server \"{server_name}\" did not complete: {message}{suffix}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bearer(access_token: &str) -> serde_json::Value {
        serde_json::json!({
            "access_token": access_token,
            "token_type": "Bearer",
        })
    }

    #[test]
    fn sanitize_store_key_strips_traversal_and_unsafe_characters() {
        assert_eq!(sanitize_store_key("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(sanitize_store_key("a/b/c").unwrap(), "c");
        assert_eq!(
            sanitize_store_key("My Server!Name").unwrap(),
            "My_Server_Name"
        );
        assert_eq!(sanitize_store_key(".dot").unwrap(), "_dot");
        let error = sanitize_store_key("").unwrap_err();
        assert!(error.contains("Invalid"), "{error}");
    }

    #[test]
    fn json_store_round_trips_replaces_in_place_and_ignores_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = JsonFileStore::new(dir.path());
        store
            .write("token.json", &serde_json::json!({"access_token": "old"}))
            .unwrap();
        store
            .write("token.json", &serde_json::json!({"access_token": "new"}))
            .unwrap();
        assert_eq!(store.read("token.json").unwrap()["access_token"], "new");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(names.is_empty(), "{names:?}");
        assert!(store.read("missing.json").is_none());
        std::fs::write(dir.path().join("broken.json"), "{").unwrap();
        assert!(store.read("broken.json").is_none());
        store
            .write("keep.json", &serde_json::json!({"a": 1}))
            .unwrap();
        store.remove("keep.json").unwrap();
        assert!(store.read("keep.json").is_none());
        store.remove("keep.json").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn json_store_writes_user_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = JsonFileStore::new(dir.path());
        store
            .write("secret.json", &serde_json::json!({"token": "abc"}))
            .unwrap();
        let mode = std::fs::metadata(dir.path().join("secret.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn tokens_are_isolated_by_url_and_by_the_original_server_name() {
        let dir = tempfile::tempdir().unwrap();
        let store = JsonFileStore::new(dir.path());
        let first =
            McpOAuthClientProvider::new("linear", "https://first.example.com/mcp", store.clone())
                .unwrap();
        let second =
            McpOAuthClientProvider::new("linear", "https://second.example.com/mcp", store.clone())
                .unwrap();
        first.save_tokens(&bearer("first-token")).unwrap();
        second.save_tokens(&bearer("second-token")).unwrap();
        assert_ne!(first.store_key, second.store_key);
        assert_eq!(first.tokens().unwrap()["access_token"], "first-token");
        assert_eq!(second.tokens().unwrap()["access_token"], "second-token");

        let spaced =
            McpOAuthClientProvider::new("team mcp", "https://same.example.com/mcp", store.clone())
                .unwrap();
        let banged =
            McpOAuthClientProvider::new("team!mcp", "https://same.example.com/mcp", store.clone())
                .unwrap();
        spaced.save_tokens(&bearer("space-token")).unwrap();
        banged.save_tokens(&bearer("bang-token")).unwrap();
        assert_ne!(spaced.store_key, banged.store_key);
        assert_eq!(spaced.tokens().unwrap()["access_token"], "space-token");
        assert_eq!(banged.tokens().unwrap()["access_token"], "bang-token");

        let service = McpOAuthService::new(store);
        assert!(service.has_tokens("linear", "https://first.example.com/mcp"));
        assert!(service.has_tokens("linear", "https://second.example.com/mcp"));
        assert!(!service.has_tokens("linear", "https://third.example.com/mcp"));

        let scoped_dir = tempfile::tempdir().unwrap();
        let scoped = McpOAuthService::new(JsonFileStore::new(scoped_dir.path()));
        scoped
            .get_provider("linear", "https://first.example.com/mcp")
            .unwrap()
            .save_tokens(&bearer("only-first"))
            .unwrap();
        assert!(scoped.has_tokens("linear", "https://first.example.com/mcp"));
        assert!(!scoped.has_tokens("linear", "https://second.example.com/mcp"));
    }

    #[test]
    fn stored_client_redirect_is_used_when_no_callback_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let provider = McpOAuthClientProvider::new(
            "notion",
            "https://mcp.notion.com/mcp",
            JsonFileStore::new(dir.path()),
        )
        .unwrap();
        provider
            .save_client_information(&serde_json::json!({
                "client_id": "cached-client",
                "redirect_uris": ["http://127.0.0.1:45678/callback"],
                "token_endpoint_auth_method": "none",
            }))
            .unwrap();
        assert_eq!(provider.redirect_url(), "http://127.0.0.1:45678/callback");
        assert_eq!(
            provider.client_metadata().redirect_uris,
            vec!["http://127.0.0.1:45678/callback".to_string()]
        );
    }

    #[test]
    fn redirect_to_authorization_captures_the_url_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut provider = McpOAuthClientProvider::new(
            "notion",
            "https://mcp.notion.com/mcp",
            JsonFileStore::new(dir.path()),
        )
        .unwrap();
        provider.redirect_to_authorization("https://example.com/authorize?state=abc");
        assert_eq!(
            provider.take_authorization_url().as_deref(),
            Some("https://example.com/authorize?state=abc")
        );
        assert!(provider.take_authorization_url().is_none());
    }

    async fn hit(redirect_uri: &str, query: &str) -> u16 {
        let response = reqwest::get(format!("{redirect_uri}?{query}"))
            .await
            .expect("callback request");
        let status = response.status().as_u16();
        let _ = response.bytes().await;
        status
    }

    #[tokio::test]
    async fn callback_resolves_a_code_that_arrives_after_waiting_starts() {
        let server = start_callback_server().await.unwrap();
        let pending = server.wait_for_code(5_000);
        let status = hit(server.redirect_uri(), "code=abc123&state=xyz").await;
        assert_eq!(status, 200);
        let code = pending.await.unwrap();
        assert_eq!(code.code, "abc123");
        assert_eq!(code.state.as_deref(), Some("xyz"));
        server.close().await;
    }

    #[tokio::test]
    async fn callback_delivers_a_code_that_arrived_before_wait_for_code() {
        let server = start_callback_server().await.unwrap();
        let status = hit(server.redirect_uri(), "code=early42&state=s1").await;
        assert_eq!(status, 200);
        let code = server.wait_for_code(1_000).await.unwrap();
        assert_eq!(code.code, "early42");
        assert_eq!(code.state.as_deref(), Some("s1"));
        server.close().await;
    }

    #[tokio::test]
    async fn callback_delivers_an_oauth_error_that_arrived_before_waiting() {
        let server = start_callback_server().await.unwrap();
        let status = hit(server.redirect_uri(), "error=access_denied").await;
        assert_eq!(status, 400);
        let error = server.wait_for_code(1_000).await.unwrap_err();
        assert!(error.contains("OAuth error: access_denied"), "{error}");
        server.close().await;
    }

    #[tokio::test]
    async fn callback_times_out_when_nothing_arrives() {
        let server = start_callback_server().await.unwrap();
        let error = server.wait_for_code(50).await.unwrap_err();
        assert!(error.contains("OAuth callback timed out"), "{error}");
        server.close().await;
    }

    #[tokio::test]
    async fn authenticate_tool_publishes_the_url_and_reconnects_on_success() {
        let url = "https://example.com/authorize?state=abc";
        let mut reconnects = 0;
        let mut updates = Vec::new();
        let output = run_mcp_authenticate(
            "notion",
            || async {
                Ok(BeginOutcome::Redirect {
                    authorization_url: url.to_string(),
                })
            },
            || async { Ok(()) },
            || async {
                reconnects += 1;
                Ok(())
            },
            &mut updates,
        )
        .await;
        assert!(!output.is_error);
        assert!(
            output.output.contains("authenticated successfully"),
            "{}",
            output.output
        );
        assert_eq!(reconnects, 1);
        assert!(updates.iter().any(|update| matches!(
            update,
            AuthUpdate::Status(text) if text.contains(url)
        )));
        assert!(updates.iter().any(|update| matches!(
            update,
            AuthUpdate::AuthorizationUrl { server_name, authorization_url }
                if server_name == "notion" && authorization_url == url
        )));
    }

    #[tokio::test]
    async fn authenticate_tool_reconnects_when_already_authorized() {
        let mut reconnects = 0;
        let mut updates = Vec::new();
        let output = run_mcp_authenticate(
            "notion",
            || async { Err(BeginError::AlreadyAuthorized) },
            || async { panic!("complete is not used") },
            || async {
                reconnects += 1;
                Ok(())
            },
            &mut updates,
        )
        .await;
        assert!(!output.is_error);
        assert!(
            output
                .output
                .contains("already had valid OAuth credentials")
        );
        assert_eq!(reconnects, 1);
    }

    #[tokio::test]
    async fn authenticate_tool_reports_a_failed_start_a_failed_callback_and_a_failed_reconnect() {
        let url = "https://example.com/authorize?state=abc";
        let mut updates = Vec::new();
        let failed = run_mcp_authenticate(
            "notion",
            || async { Err(BeginError::Failed("DCR unsupported".to_string())) },
            || async { Ok(()) },
            || async { Ok(()) },
            &mut updates,
        )
        .await;
        assert!(failed.is_error);
        assert!(
            failed.output.contains("DCR unsupported"),
            "{}",
            failed.output
        );

        let timed_out = run_mcp_authenticate(
            "notion",
            || async {
                Ok(BeginOutcome::Redirect {
                    authorization_url: url.to_string(),
                })
            },
            || async { Err("OAuth callback timed out".to_string()) },
            || async { Ok(()) },
            &mut Vec::new(),
        )
        .await;
        assert!(timed_out.is_error);
        assert!(
            timed_out.output.contains("timed out"),
            "{}",
            timed_out.output
        );
        assert!(timed_out.output.contains(url), "{}", timed_out.output);

        let reconnect_failed = run_mcp_authenticate(
            "notion",
            || async {
                Ok(BeginOutcome::Redirect {
                    authorization_url: url.to_string(),
                })
            },
            || async { Ok(()) },
            || async { Err("reconnect failed".to_string()) },
            &mut Vec::new(),
        )
        .await;
        assert!(reconnect_failed.is_error);
        assert!(reconnect_failed.output.contains("reconnect failed"));
    }
}
