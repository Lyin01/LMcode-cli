//! Google GenAI (Gemini) provider (streaming).
//!
//! Targets `models/{model}:streamGenerateContent?alt=sse`: SSE chunks carry
//! `candidates[].content.parts[]` (text, `thought: true` reasoning, and
//! `functionCall` tool invocations) plus `usageMetadata`. Mirrors the mapping
//! in `packages/liumir/src/providers/google-genai.ts`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt};
use serde_json::{Value, json};

use crate::error::LlmError;
use crate::message::{ContentPart, Message, Role, StreamedMessagePart, ToolCall};
use crate::provider::{
    BoxStream, ChatProvider, FinishReason, GenerateOptions, StreamSummary, StreamedMessage,
};
use crate::providers::ProviderConfig;
use crate::sse::SseParser;
use crate::tool::Tool;
use crate::usage::TokenUsage;

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const API_VERSION: &str = "v1beta";

/// Streaming provider for the Google Generative Language API (Gemini).
pub struct GenaiProvider {
    name: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
}

impl GenaiProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, LlmError> {
        if config.model.trim().is_empty() {
            return Err(LlmError::Config(format!(
                "provider `{}` has no model selected",
                config.name
            )));
        }
        Ok(Self {
            name: config.name,
            model: config.model,
            base_url: config
                .base_url
                .filter(|url| !url.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            api_key: config.api_key,
            headers: config.headers,
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait::async_trait]
impl ChatProvider for GenaiProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
        options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError> {
        let body = build_request_body(system_prompt, tools, history);
        let url = format!(
            "{}/{API_VERSION}/models/{}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/'),
            self.model
        );

        let mut request = self
            .client
            .post(&url)
            .header("accept", "text/event-stream")
            .json(&body);
        if let Some(api_key) = options.api_key.as_deref().or(self.api_key.as_deref()) {
            request = request.header("x-goog-api-key", api_key);
        }
        for (name, value) in self.headers.iter().chain(options.headers.iter()) {
            request = request.header(name, value);
        }

        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(LlmError::Api {
                status: status.as_u16(),
                message: extract_error_message(&body),
            });
        }

        let summary = Arc::new(Mutex::new(StreamSummary::default()));
        let parts = build_parts_stream(response, Arc::clone(&summary));
        Ok(StreamedMessage::new(parts, summary))
    }
}

struct StreamState {
    byte_stream: BoxStream<Result<bytes::Bytes, reqwest::Error>>,
    parser: SseParser,
    pending: VecDeque<Result<StreamedMessagePart, LlmError>>,
    next_call_id: u64,
    finished: bool,
    summary: Arc<Mutex<StreamSummary>>,
}

pub(crate) fn build_parts_stream(
    response: reqwest::Response,
    summary: Arc<Mutex<StreamSummary>>,
) -> BoxStream<Result<StreamedMessagePart, LlmError>> {
    let state = StreamState {
        byte_stream: Box::pin(response.bytes_stream()),
        parser: SseParser::new(),
        pending: VecDeque::new(),
        next_call_id: 1,
        finished: false,
        summary,
    };

    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if let Some(item) = state.pending.pop_front() {
                return Some((item, state));
            }
            if state.finished {
                return None;
            }
            match state.byte_stream.next().await {
                None => return None,
                Some(Err(error)) => {
                    state.finished = true;
                    return Some((Err(LlmError::Http(error)), state));
                }
                Some(Ok(bytes)) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for event in state.parser.push(&text) {
                        handle_sse_data(&mut state, &event.data);
                        if state.finished {
                            break;
                        }
                    }
                }
            }
        }
    }))
}

fn handle_sse_data(state: &mut StreamState, data: &str) {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        if data == "[DONE]" {
            state.finished = true;
        }
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };

    if let Some(usage) = value.get("usageMetadata") {
        let mut summary = state.summary.lock().unwrap();
        summary.usage = Some(TokenUsage {
            input_tokens: usage["promptTokenCount"].as_u64().unwrap_or(0),
            output_tokens: usage["candidatesTokenCount"].as_u64().unwrap_or(0),
            cache_read_tokens: usage["cachedContentTokenCount"].as_u64(),
        });
    }

    let Some(candidates) = value.get("candidates").and_then(Value::as_array) else {
        return;
    };
    for candidate in candidates {
        if let Some(raw) = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            let mut summary = state.summary.lock().unwrap();
            summary.finish_reason = Some(map_genai_finish_reason(raw));
            summary.raw_finish_reason = Some(raw.to_string());
        }
        let Some(parts) = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for part in parts {
            if let Some(call) = part.get("functionCall") {
                let name = call["name"].as_str().unwrap_or_default().to_string();
                let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                // Gemini does not issue call ids; synthesize stable ones.
                let id = format!("call_{}", state.next_call_id);
                state.next_call_id += 1;
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::ToolCall(ToolCall {
                        id,
                        name,
                        arguments: serde_json::to_string(&args).ok(),
                        stream_index: None,
                    })));
            } else if let Some(text) = part.get("text").and_then(Value::as_str) {
                if text.is_empty() {
                    continue;
                }
                let is_thought = part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_thought {
                    let signature = part
                        .get("thoughtSignature")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    state
                        .pending
                        .push_back(Ok(StreamedMessagePart::Content(ContentPart::Think {
                            think: text.to_string(),
                            encrypted: signature,
                        })));
                } else {
                    state
                        .pending
                        .push_back(Ok(StreamedMessagePart::Content(ContentPart::Text {
                            text: text.to_string(),
                        })));
                }
            }
        }
    }
}

/// Normalize a Gemini `finishReason` (tool calls keep `completed`, matching
/// the TS mapping — tool usage is detected via `parts[].functionCall`).
fn map_genai_finish_reason(raw: &str) -> FinishReason {
    match raw {
        "STOP" => FinishReason::Completed,
        "MAX_TOKENS" => FinishReason::Truncated,
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
            FinishReason::Filtered
        }
        _ => FinishReason::Other,
    }
}

pub(crate) fn build_request_body(
    system_prompt: &str,
    tools: &[Tool],
    history: &[Message],
) -> Value {
    let mut body = json!({ "contents": build_contents(history) });
    if !system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system_prompt }] });
    }
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    })
                })
                .collect::<Vec<_>>()
        }]);
    }
    body
}

fn build_contents(history: &[Message]) -> Vec<Value> {
    // Map synthesized call ids back to tool names for functionResponse.
    let mut call_names: HashMap<String, String> = HashMap::new();
    for message in history {
        for call in &message.tool_calls {
            call_names.insert(call.id.clone(), call.name.clone());
        }
    }

    let mut contents: Vec<Value> = Vec::new();
    for message in history {
        match message.role {
            Role::User | Role::System => {
                // GenAI roles only accept "user" / "model"; historical system
                // messages become user content.
                let mut parts: Vec<Value> = Vec::new();
                for part in &message.content {
                    match part {
                        ContentPart::Text { text } => {
                            if !text.is_empty() {
                                parts.push(json!({ "text": text }));
                            }
                        }
                        ContentPart::ImageUrl { image_url } => {
                            parts.push(convert_media_url(&image_url.url, "image/jpeg"));
                        }
                        ContentPart::VideoUrl { video_url } => {
                            parts.push(convert_media_url(&video_url.url, "video/mp4"));
                        }
                        ContentPart::AudioUrl { audio_url } => {
                            parts.push(convert_media_url(&audio_url.url, "audio/mpeg"));
                        }
                        ContentPart::Think { .. } => {}
                    }
                }
                if !parts.is_empty() {
                    push_content(&mut contents, "user", parts);
                }
            }
            Role::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                for part in &message.content {
                    match part {
                        ContentPart::Text { text } => parts.push(json!({ "text": text })),
                        ContentPart::Think { think, encrypted } => {
                            let mut thought = json!({ "text": think, "thought": true });
                            if let Some(signature) = encrypted {
                                thought["thoughtSignature"] = json!(signature);
                            }
                            parts.push(thought);
                        }
                        ContentPart::ImageUrl { image_url } => {
                            parts.push(convert_media_url(&image_url.url, "image/jpeg"));
                        }
                        ContentPart::VideoUrl { video_url } => {
                            parts.push(convert_media_url(&video_url.url, "video/mp4"));
                        }
                        ContentPart::AudioUrl { audio_url } => {
                            parts.push(convert_media_url(&audio_url.url, "audio/mpeg"));
                        }
                    }
                }
                for call in &message.tool_calls {
                    let args: Value = call
                        .arguments
                        .as_deref()
                        .and_then(|arguments| serde_json::from_str(arguments).ok())
                        .unwrap_or_else(|| json!({}));
                    parts.push(json!({ "functionCall": { "name": call.name, "args": args } }));
                }
                if !parts.is_empty() {
                    push_content(&mut contents, "model", parts);
                }
            }
            Role::Tool => {
                let name = message
                    .tool_call_id
                    .as_ref()
                    .and_then(|id| call_names.get(id))
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                let text = message.text();
                push_content(
                    &mut contents,
                    "user",
                    vec![json!({
                        "functionResponse": {
                            "name": name,
                            "response": { "result": text },
                        }
                    })],
                );
            }
        }
    }
    contents
}

/// Push a content entry, merging into the previous one when roles match.
fn push_content(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if let Some(last) = contents.last_mut()
        && last["role"] == role
        && let Some(existing) = last["parts"].as_array_mut()
    {
        existing.extend(parts);
        return;
    }
    contents.push(json!({ "role": role, "parts": parts }));
}

/// Convert a media URL to a Gemini `inlineData`/`fileData` part (mirrors
/// `convertMediaUrl` in the TS provider).
pub(crate) fn convert_media_url(url: &str, fallback_mime_type: &str) -> Value {
    if let Some(rest) = url.strip_prefix("data:") {
        let Some((meta, data)) = rest.split_once(',') else {
            return json!({ "fileData": { "fileUri": url, "mimeType": fallback_mime_type } });
        };
        let mime_type = meta
            .split_once(';')
            .map(|(mime, _)| mime)
            .filter(|mime| !mime.is_empty())
            .unwrap_or(fallback_mime_type);
        return json!({ "inlineData": { "mimeType": mime_type, "data": data } });
    }
    let pathname = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    let mut mime_type = fallback_mime_type;
    if pathname.ends_with(".png") {
        mime_type = "image/png";
    } else if pathname.ends_with(".jpg") || pathname.ends_with(".jpeg") {
        mime_type = "image/jpeg";
    } else if pathname.ends_with(".gif") {
        mime_type = "image/gif";
    } else if pathname.ends_with(".webp") {
        mime_type = "image/webp";
    } else if pathname.ends_with(".mp3") || pathname.ends_with(".mpeg") {
        mime_type = "audio/mpeg";
    } else if pathname.ends_with(".wav") {
        mime_type = "audio/wav";
    } else if pathname.ends_with(".ogg") {
        mime_type = "audio/ogg";
    }
    json!({ "fileData": { "fileUri": url, "mimeType": mime_type } })
}

pub(crate) fn extract_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body)
        && let Some(message) = value.pointer("/error/message").and_then(Value::as_str)
    {
        return message.to_string();
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "(empty response body)".to_string()
    } else {
        trimmed.chars().take(500).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_finish_reasons() {
        assert_eq!(map_genai_finish_reason("STOP"), FinishReason::Completed);
        assert_eq!(
            map_genai_finish_reason("MAX_TOKENS"),
            FinishReason::Truncated
        );
        assert_eq!(map_genai_finish_reason("SAFETY"), FinishReason::Filtered);
        assert_eq!(
            map_genai_finish_reason("RECITATION"),
            FinishReason::Filtered
        );
        assert_eq!(
            map_genai_finish_reason("SOMETHING_NEW"),
            FinishReason::Other
        );
    }

    #[test]
    fn builds_contents_with_roles_tools_and_function_responses() {
        let history = vec![
            Message::user("read a.txt"),
            Message::assistant(
                vec![],
                vec![ToolCall::new(
                    "call_1",
                    "Read",
                    Some("{\"path\":\"a.txt\"}".to_string()),
                )],
            ),
            Message::tool_result("call_1", "file-content"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "done".into(),
                }],
                vec![],
            ),
        ];
        let contents = build_contents(&history);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "read a.txt");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["functionCall"]["name"], "Read");
        assert_eq!(
            contents[1]["parts"][0]["functionCall"]["args"]["path"],
            "a.txt"
        );
        // Tool result merges into a user content with a functionResponse.
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["functionResponse"]["name"], "Read");
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["response"]["result"],
            "file-content"
        );
        assert_eq!(contents[3]["role"], "model");
        assert_eq!(contents[3]["parts"][0]["text"], "done");
    }

    #[test]
    fn merges_consecutive_same_role_contents() {
        let history = vec![
            Message::tool_result("call_1", "a"),
            Message::tool_result("call_2", "b"),
        ];
        // No call-name mapping → both become "unknown", but they must merge.
        let contents = build_contents(&history);
        assert_eq!(contents.len(), 1, "consecutive user contents merge");
        assert_eq!(contents[0]["parts"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn request_body_carries_system_and_tool_declarations() {
        let tools = vec![Tool {
            name: "Read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let body = build_request_body("be nice", &tools, &[Message::user("hi")]);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be nice");
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "Read");
        assert_eq!(body["contents"][0]["role"], "user");
    }

    #[test]
    fn media_urls_convert_to_gemini_parts() {
        assert_eq!(
            convert_media_url("https://x/clip.mp4", "video/mp4"),
            json!({ "fileData": { "fileUri": "https://x/clip.mp4", "mimeType": "video/mp4" } })
        );
        // Extension inference for http(s) URLs (query strings are ignored).
        assert_eq!(
            convert_media_url("https://x/pic.png?token=1", "image/jpeg"),
            json!({ "fileData": { "fileUri": "https://x/pic.png?token=1", "mimeType": "image/png" } })
        );
        // Data URLs become inlineData with the embedded mime type.
        assert_eq!(
            convert_media_url("data:video/mp4;base64,AAAA", "video/mp4"),
            json!({ "inlineData": { "mimeType": "video/mp4", "data": "AAAA" } })
        );
        // Non-data URLs with unknown extensions keep the fallback.
        assert_eq!(
            convert_media_url("ms://file-1", "video/mp4"),
            json!({ "fileData": { "fileUri": "ms://file-1", "mimeType": "video/mp4" } })
        );
        // Audio extensions are inferred too.
        assert_eq!(
            convert_media_url("https://x/song.mp3", "audio/mpeg"),
            json!({ "fileData": { "fileUri": "https://x/song.mp3", "mimeType": "audio/mpeg" } })
        );
        assert_eq!(
            convert_media_url("https://x/voice.ogg", "audio/mpeg"),
            json!({ "fileData": { "fileUri": "https://x/voice.ogg", "mimeType": "audio/ogg" } })
        );
    }

    #[test]
    fn user_messages_with_media_emit_media_parts() {
        let message = Message {
            role: crate::message::Role::User,
            name: None,
            content: vec![
                ContentPart::Text {
                    text: "listen".to_string(),
                },
                ContentPart::AudioUrl {
                    audio_url: crate::message::ImageUrl {
                        url: "ms://audio-1".to_string(),
                        id: Some("audio-1".to_string()),
                    },
                },
            ],
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
        };
        let contents = build_contents(std::slice::from_ref(&message));
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["text"], "listen");
        assert_eq!(
            parts[1],
            json!({ "fileData": { "fileUri": "ms://audio-1", "mimeType": "audio/mpeg" } })
        );
    }
}
