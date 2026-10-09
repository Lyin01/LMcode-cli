//! Web tools: `FetchURL` (real HTTP fetch + HTML text extraction) and
//! `WebSearch` (provider-backed; registered only when a provider exists) —
//! mirrors `tools/builtin/web`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::Tool;

/// How fetched content relates to the original response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlFetchKind {
    /// The body was already text/markdown — returned verbatim.
    Passthrough,
    /// An HTML page — main text extracted.
    Extracted,
}

/// One search result from a provider.
#[derive(Debug, Clone)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub date: Option<String>,
    pub content: Option<String>,
}

/// Host-injected search backend (mirrors `WebSearchProvider`).
#[async_trait]
pub trait WebSearchProvider: Send + Sync {
    async fn search(
        &self,
        query: &str,
        limit: Option<u64>,
        include_content: bool,
    ) -> Result<Vec<WebSearchResult>, String>;
}

/// `FetchURL` — fetch a URL and return its text (verbatim or extracted).
pub struct FetchUrlTool {
    client: reqwest::Client,
}

impl FetchUrlTool {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .user_agent("lmcode-rust/0.1")
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Default for FetchUrlTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for FetchUrlTool {
    fn name(&self) -> &str {
        "FetchURL"
    }

    fn description(&self) -> &str {
        "Fetch content from a URL. Returns the main text content extracted from the page. Only \
         public http(s) URLs are supported."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch content from."
                }
            },
            "required": ["url"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let url = arguments["url"].as_str().ok_or("missing `url` argument")?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("only public http(s) URLs are supported".to_string());
        }
        let response =
            self.client.get(url).send().await.map_err(|error| {
                format!("Failed to fetch URL due to network error: {url}. {error}")
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Failed to fetch URL. Status: {}. {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to fetch URL due to network error: {url}. {error}"))?;
        if body.trim().is_empty() {
            return Ok("The response body is empty.".to_string());
        }
        let (content, kind) = if content_type.contains("text/html") {
            (html_to_text(&body), UrlFetchKind::Extracted)
        } else {
            (body, UrlFetchKind::Passthrough)
        };
        let note = match kind {
            UrlFetchKind::Passthrough => {
                "The returned content is the full response body, returned verbatim."
            }
            UrlFetchKind::Extracted => {
                "The returned content is the main text extracted from the page."
            }
        };
        Ok(format!("[{note}]\n{content}"))
    }
}

/// `WebSearch` — provider-backed search (mirrors the TS host-injection
/// contract: without a provider the host does not register this tool).
pub struct WebSearchTool {
    provider: Arc<dyn WebSearchProvider>,
}

impl WebSearchTool {
    pub fn new(provider: Arc<dyn WebSearchProvider>) -> Self {
        Self { provider }
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "WebSearch"
    }

    fn description(&self) -> &str {
        "Search the web for information. Use this when you need up-to-date information from the \
         internet. Each result includes its title, URL, snippet, and—when available—a publication \
         date. When `include_content` is enabled, the full page content—when available—is \
         appended after the snippet."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results"
                },
                "include_content": {
                    "type": "boolean",
                    "description": "Include the full page content when available"
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        let query = arguments["query"]
            .as_str()
            .ok_or("missing `query` argument")?;
        let limit = arguments["limit"].as_u64();
        let include_content = arguments["include_content"].as_bool() == Some(true);
        let results = self
            .provider
            .search(query, limit, include_content)
            .await
            .map_err(classify_search_error)?;
        if results.is_empty() {
            return Ok("No search results found.".to_string());
        }
        let mut output = String::new();
        for (index, result) in results.iter().enumerate() {
            if index > 0 {
                output.push_str("---\n\n");
            }
            output.push_str(&format!("Title: {}\n", result.title));
            if let Some(date) = &result.date {
                output.push_str(&format!("Date: {date}\n"));
            }
            output.push_str(&format!("URL: {}\n", result.url));
            output.push_str(&format!("Snippet: {}\n\n", result.snippet));
            if let Some(content) = &result.content {
                output.push_str(content);
                output.push_str("\n\n");
            }
        }
        Ok(output)
    }
}

/// Categorised search error text (mirrors `classifySearchError`).
fn classify_search_error(message: String) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("abort") {
        return format!("Search cancelled: {message}");
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return format!("Search timed out: {message}");
    }
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("auth") {
        return format!("Search failed (authentication): {message}");
    }
    if lower.contains("http ") || lower.contains("network") || lower.contains("fetch") {
        return format!("Search failed (network): {message}");
    }
    format!("Search failed: {message}")
}

/// Small HTML→text pass: drops scripts/styles/tags, decodes the common
/// entities, and collapses whitespace (a lighter stand-in for the host
/// extractor in the TS build).
pub fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut output = String::with_capacity(html.len() / 2);
    let mut index = 0usize;
    while index < html.len() {
        let Some(relative) = html[index..].find('<') else {
            output.push_str(&html[index..]);
            break;
        };
        let tag_start = index + relative;
        output.push_str(&html[index..tag_start]);
        let Some(relative_end) = html[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end;
        let tag = &lower[tag_start + 1..tag_end];
        let name = tag
            .trim_start_matches('/')
            .split(|ch: char| ch.is_whitespace() || ch == '/')
            .next()
            .unwrap_or("");
        if !tag.starts_with('/') && (name == "script" || name == "style") {
            // Skip the whole element, including its contents.
            let close = format!("</{name}");
            if let Some(close_start) = lower[tag_end..].find(&close) {
                index = tag_end + close_start;
                if let Some(close_end) = html[index..].find('>') {
                    index += close_end + 1;
                    continue;
                }
            }
            break;
        }
        if matches!(
            name,
            "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
        ) {
            output.push('\n');
        }
        index = tag_end + 1;
    }
    collapse_whitespace(&decode_entities(&output))
}

fn decode_entities(text: &str) -> String {
    // `&amp;` last so it does not re-decode other entities.
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn collapse_whitespace(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut pending_space = false;
    let mut newlines = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines <= 2 {
                output.push('\n');
            }
            pending_space = false;
        } else if ch.is_whitespace() {
            if !pending_space && newlines == 0 {
                output.push(' ');
                pending_space = true;
            }
        } else {
            newlines = 0;
            pending_space = false;
            output.push(ch);
        }
    }
    output.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_extraction_strips_tags_and_scripts() {
        let html = "<html><head><style>body{}</style><script>var x = 1 < 2;</script></head>\
                    <body><h1>Title</h1><p>Hello &amp; welcome</p><p>Second&nbsp;line</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Title"), "{text}");
        assert!(text.contains("Hello & welcome"), "{text}");
        assert!(text.contains("Second line"), "{text}");
        assert!(!text.contains("var x"), "{text}");
        assert!(!text.contains("body{}"), "{text}");
        assert!(!text.contains('<'), "{text}");
    }

    #[tokio::test]
    async fn fetch_url_extracts_html_and_reports_status_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        async fn serve(response: String) -> std::net::SocketAddr {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.ok();
            });
            addr
        }

        let body = "<html><body><p>fetched <b>content</b></p></body></html>";
        let addr = serve(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let tool = FetchUrlTool::new();
        let output = tool
            .execute(&json!({ "url": format!("http://{addr}/") }), Path::new("."))
            .await
            .unwrap();
        assert!(output.contains("extracted from the page"), "{output}");
        assert!(output.contains("fetched content"), "{output}");

        let addr = serve(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        )
        .await;
        let error = tool
            .execute(
                &json!({ "url": format!("http://{addr}/missing") }),
                Path::new("."),
            )
            .await
            .unwrap_err();
        assert!(error.contains("Status: 404"), "{error}");

        let error = tool
            .execute(&json!({ "url": "file:///etc/passwd" }), Path::new("."))
            .await
            .unwrap_err();
        assert!(error.contains("http(s)"), "{error}");
    }

    struct FakeProvider;

    #[async_trait]
    impl WebSearchProvider for FakeProvider {
        async fn search(
            &self,
            _query: &str,
            _limit: Option<u64>,
            _include_content: bool,
        ) -> Result<Vec<WebSearchResult>, String> {
            Ok(vec![WebSearchResult {
                title: "Result".to_string(),
                url: "https://example.com".to_string(),
                snippet: "A snippet".to_string(),
                date: Some("2026-01-01".to_string()),
                content: Some("Full content".to_string()),
            }])
        }
    }

    struct FailingProvider;

    #[async_trait]
    impl WebSearchProvider for FailingProvider {
        async fn search(
            &self,
            _query: &str,
            _limit: Option<u64>,
            _include_content: bool,
        ) -> Result<Vec<WebSearchResult>, String> {
            Err("request timed out after 30s".to_string())
        }
    }

    #[tokio::test]
    async fn web_search_formats_results_and_classifies_errors() {
        let tool = WebSearchTool::new(Arc::new(FakeProvider));
        let output = tool
            .execute(&json!({ "query": "rust" }), Path::new("."))
            .await
            .unwrap();
        assert!(output.contains("Title: Result"), "{output}");
        assert!(output.contains("Date: 2026-01-01"), "{output}");
        assert!(output.contains("URL: https://example.com"), "{output}");
        assert!(output.contains("Full content"), "{output}");

        let failing = WebSearchTool::new(Arc::new(FailingProvider));
        let error = failing
            .execute(&json!({ "query": "rust" }), Path::new("."))
            .await
            .unwrap_err();
        assert!(error.starts_with("Search timed out:"), "{error}");
    }
}
