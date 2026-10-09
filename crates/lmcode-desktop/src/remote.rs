//! LAN remote access: a small HTTP service that serves a mobile chat page,
//! pairs via a token, forwards messages to the agent worker, and streams
//! agent events over SSE (mirrors `apps/lmcode-desktop/src/main/remote`).

use std::net::IpAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::{Html, IntoResponse};
use axum::routing::{get, post};
use serde::Deserialize;
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::bridge::AgentCommand;

/// Public state of the remote service (for the connect panel).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub enabled: bool,
    pub token: String,
    pub port: u16,
    pub lan_urls: Vec<String>,
}

/// Everything the HTTP handlers need.
struct RemoteContext {
    token: String,
    commands: mpsc::UnboundedSender<AgentCommand>,
    approval: Arc<tokio::sync::Mutex<Option<oneshot::Sender<bool>>>>,
    events: broadcast::Sender<String>,
    status: Arc<Mutex<Option<crate::bridge::StatusPayload>>>,
}

/// A running remote service.
pub struct RemoteService {
    pub state: RemoteState,
    shutdown: Option<oneshot::Sender<()>>,
}

impl RemoteService {
    /// Start serving on a random port; returns the state (with LAN URLs).
    pub async fn start(
        commands: mpsc::UnboundedSender<AgentCommand>,
        approval: Arc<tokio::sync::Mutex<Option<oneshot::Sender<bool>>>>,
        events: broadcast::Sender<String>,
        status: Arc<Mutex<Option<crate::bridge::StatusPayload>>>,
    ) -> Result<Self, String> {
        let token = generate_token();
        let context = Arc::new(RemoteContext {
            token: token.clone(),
            commands,
            approval,
            events,
            status,
        });

        let app = Router::new()
            .route("/", get(remote_page))
            .route("/api/state", get(api_state))
            .route("/api/events", get(api_events))
            .route("/api/message", post(api_message))
            .route("/api/approve", post(api_approve))
            .with_state(Arc::clone(&context));

        let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|error| format!("failed to bind remote service: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        tokio::spawn(async move {
            let _ = serve.await;
        });

        let lan_urls = lan_urls(port);
        Ok(Self {
            state: RemoteState {
                enabled: true,
                token,
                port,
                lan_urls,
            },
            shutdown: Some(shutdown_tx),
        })
    }

    /// Stop the service.
    pub fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for RemoteService {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 32-hex pairing token.
pub fn generate_token() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed =
        nanos ^ (nanos >> 37) ^ ((std::process::id() as u128) << 19) ^ ((counter as u128) << 43);
    format!(
        "{:016x}{:016x}",
        (mixed & 0xffff_ffff_ffff_ffff) as u64,
        (mixed >> 64) as u64
    )
}

/// LAN URLs for the pairing panel (best-effort; falls back to localhost).
fn lan_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(ip) = local_ip() {
        urls.push(format!("http://{ip}:{port}"));
    }
    urls.push(format!("http://127.0.0.1:{port}"));
    urls
}

/// Discover the LAN address via a UDP connect trick (no traffic is sent).
fn local_ip() -> Result<IpAddr, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|error| error.to_string())?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|error| error.to_string())?;
    socket
        .local_addr()
        .map(|addr| addr.ip())
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

fn authorized(context: &RemoteContext, token: Option<&str>) -> bool {
    token.map(str::trim) == Some(context.token.as_str())
}

async fn remote_page() -> Html<&'static str> {
    Html(REMOTE_PAGE)
}

async fn api_state(
    State(context): State<Arc<RemoteContext>>,
    Query(query): Query<TokenQuery>,
) -> impl IntoResponse {
    if !authorized(&context, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let status = context.status.lock().await.clone();
    let payload = serde_json::json!({
        "model": status.as_ref().map(|s| s.model.clone()).unwrap_or_default(),
        "session": status.as_ref().map(|s| s.session.clone()).unwrap_or_default(),
    });
    (StatusCode::OK, axum::Json(payload)).into_response()
}

async fn api_events(
    State(context): State<Arc<RemoteContext>>,
    Query(query): Query<TokenQuery>,
) -> impl IntoResponse {
    if !authorized(&context, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let receiver = context.events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|message| match message {
        Ok(data) => Some(Ok::<Event, std::convert::Infallible>(
            Event::default().data(data),
        )),
        Err(_) => None,
    });
    Sse::new(stream).into_response()
}

#[derive(Deserialize)]
struct MessageBody {
    token: String,
    text: String,
}

async fn api_message(
    State(context): State<Arc<RemoteContext>>,
    axum::Json(body): axum::Json<MessageBody>,
) -> impl IntoResponse {
    if !authorized(&context, Some(&body.token)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    if body.text.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty message").into_response();
    }
    if context
        .commands
        .send(AgentCommand::Turn {
            text: body.text,
            images: Vec::new(),
        })
        .is_err()
    {
        return (StatusCode::SERVICE_UNAVAILABLE, "agent unavailable").into_response();
    }
    (StatusCode::OK, "ok").into_response()
}

#[derive(Deserialize)]
struct ApproveBody {
    token: String,
    approved: bool,
}

async fn api_approve(
    State(context): State<Arc<RemoteContext>>,
    axum::Json(body): axum::Json<ApproveBody>,
) -> impl IntoResponse {
    if !authorized(&context, Some(&body.token)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let mut slot = context.approval.lock().await;
    if let Some(respond) = slot.take() {
        let _ = respond.send(body.approved);
    }
    (StatusCode::OK, "ok").into_response()
}

/// The self-contained mobile chat page (token arrives via `#token=`).
const REMOTE_PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LMcode Remote</title>
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #0b0e13; color: #e6e9ef; font-family: system-ui, sans-serif; }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin: 6px 0; white-space: pre-wrap; font-size: 14px; }
  .user { color: #7bd88f; }
  .assistant { color: #4cc2ff; }
  .notice { color: #9aa4b2; font-size: 12px; }
  #approval { display: none; gap: 8px; padding: 10px 12px; border-top: 1px solid #232833; align-items: center; }
  #approval button { padding: 8px 14px; border-radius: 8px; border: 1px solid #232833; background: #1a2233; color: #e6e9ef; }
  #bar { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #232833; }
  #input { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #232833; background: #0d1015; color: #e6e9ef; }
  #send { padding: 10px 14px; border-radius: 8px; border: 1px solid #232833; background: #1a2233; color: #e6e9ef; }
</style>
</head>
<body>
<div id="log"></div>
<div id="approval"><span id="approval-name" class="notice"></span><button id="approve">Approve</button><button id="deny">Deny</button></div>
<div id="bar"><input id="input" placeholder="Message…" autocomplete="off" /><button id="send">Send</button></div>
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  history.replaceState(null, "", location.pathname);
  const log = document.getElementById("log");
  const approvalBar = document.getElementById("approval");
  let lastAssistant = null;

  function add(cls, text) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  const events = new EventSource("/api/events?token=" + encodeURIComponent(token));
  events.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    switch (payload.type) {
      case "textDelta":
        if (!lastAssistant) {
          lastAssistant = document.createElement("div");
          lastAssistant.className = "msg assistant";
          log.appendChild(lastAssistant);
        }
        lastAssistant.textContent += payload.text;
        log.scrollTop = log.scrollHeight;
        break;
      case "turnFinished":
        lastAssistant = null;
        break;
      case "notice":
        add("notice", payload.message);
        break;
      case "error":
        add("notice", "error: " + payload.message);
        break;
      case "toolStart":
        add("notice", "⚙ " + payload.name);
        break;
      case "approvalRequest":
        document.getElementById("approval-name").textContent = "Approve " + payload.name + "?";
        approvalBar.style.display = "flex";
        break;
    }
  };

  async function approve(approved) {
    approvalBar.style.display = "none";
    await fetch("/api/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, approved }),
    });
  }
  document.getElementById("approve").addEventListener("click", () => approve(true));
  document.getElementById("deny").addEventListener("click", () => approve(false));

  async function send() {
    const input = document.getElementById("input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    add("user", text);
    await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, text }),
    });
  }
  document.getElementById("send").addEventListener("click", send);
  document.getElementById("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") send();
  });
</script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_hex() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn authorization_requires_an_exact_token() {
        let context = RemoteContext {
            token: "abc123".to_string(),
            commands: mpsc::unbounded_channel().0,
            approval: Arc::new(Mutex::new(None)),
            events: broadcast::channel(1).0,
            status: Arc::new(Mutex::new(None)),
        };
        assert!(authorized(&context, Some("abc123")));
        assert!(authorized(&context, Some(" abc123 ")));
        assert!(!authorized(&context, Some("abc")));
        assert!(!authorized(&context, None));
    }
}
