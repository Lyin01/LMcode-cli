//! OpenAI-compatible Chat Completions provider (streaming).
//!
//! Targets the widely deployed `/chat/completions` wire protocol: OpenAI,
//! DeepSeek, GLM, Kimi, and gateways such as `opencode.ai/zen`. Handles
//! `content`, `reasoning_content` / `reasoning` deltas, incremental
//! `tool_calls`, `finish_reason`, and (when the gateway reports it) `usage`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::LlmError;
use crate::generate::map_finish_reason;
use crate::message::{ContentPart, Message, Role, StreamedMessagePart, ToolCall};
use crate::provider::{BoxStream, ChatProvider, GenerateOptions, StreamSummary, StreamedMessage};
use crate::providers::ProviderConfig;
use crate::sse::SseParser;
use crate::tool::Tool;
use crate::usage::TokenUsage;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Streaming provider for OpenAI-compatible Chat Completions APIs.
pub struct OpenAiChatProvider {
    name: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
}

impl OpenAiChatProvider {
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
impl ChatProvider for OpenAiChatProvider {
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
        let body = build_request_body(&self.model, system_prompt, tools, history);
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));

        let mut request = self
            .client
            .post(&url)
            .header("accept", "text/event-stream")
            .json(&body);
        if let Some(api_key) = options.api_key.as_deref().or(self.api_key.as_deref()) {
            request = request.bearer_auth(api_key);
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
                retry_after_ms: None,
            });
        }

        let summary = Arc::new(Mutex::new(StreamSummary::default()));
        let parts = build_parts_stream(response, Arc::clone(&summary));
        Ok(StreamedMessage::new(parts, summary))
    }
}

/// State threaded through the `unfold` stream adapter.
struct StreamState {
    byte_stream: BoxStream<Result<bytes::Bytes, reqwest::Error>>,
    parser: SseParser,
    pending: VecDeque<Result<StreamedMessagePart, LlmError>>,
    /// Argument fragments that arrived before their tool call was named,
    /// keyed by streaming index (some gateways emit these early).
    buffered_tool_args: HashMap<u64, String>,
    emitted_tool_calls: HashSet<u64>,
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
        buffered_tool_args: HashMap::new(),
        emitted_tool_calls: HashSet::new(),
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
                None => {
                    // Stream ended without [DONE]; the state is dropped here.
                    return None;
                }
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
    if data.trim() == "[DONE]" {
        state.finished = true;
        return;
    }
    let chunk: ChatCompletionChunk = match serde_json::from_str(data) {
        Ok(chunk) => chunk,
        // Ignore frames we cannot parse (keep-alive noise, vendor extensions).
        Err(_) => return,
    };

    if let Some(id) = chunk.id.filter(|id| !id.is_empty()) {
        state.summary.lock().unwrap().id = Some(id);
    }
    if let Some(usage) = chunk.usage {
        state.summary.lock().unwrap().usage = Some(TokenUsage {
            input_tokens: usage.prompt_tokens.unwrap_or(0),
            output_tokens: usage.completion_tokens.unwrap_or(0),
            cache_read_tokens: usage
                .prompt_tokens_details
                .and_then(|details| details.cached_tokens),
        });
    }

    for choice in chunk.choices {
        if let Some(raw) = choice.finish_reason.filter(|reason| !reason.is_empty()) {
            let mut summary = state.summary.lock().unwrap();
            summary.finish_reason = Some(map_finish_reason(&raw));
            summary.raw_finish_reason = Some(raw);
        }
        if let Some(reasoning) = choice
            .delta
            .reasoning()
            .filter(|reasoning| !reasoning.is_empty())
        {
            state
                .pending
                .push_back(Ok(StreamedMessagePart::Content(ContentPart::Think {
                    think: reasoning.to_string(),
                    encrypted: None,
                })));
        }
        if let Some(content) = choice.delta.content.filter(|content| !content.is_empty()) {
            state
                .pending
                .push_back(Ok(StreamedMessagePart::Content(ContentPart::Text {
                    text: content,
                })));
        }
        if let Some(tool_calls) = choice.delta.tool_calls {
            for tool_call in tool_calls {
                handle_tool_call_delta(state, tool_call);
            }
        }
    }
}

fn handle_tool_call_delta(state: &mut StreamState, delta: ChunkToolCall) {
    let index = delta.index.unwrap_or(0);
    let name = delta
        .function
        .as_ref()
        .and_then(|function| function.name.clone())
        .filter(|name| !name.is_empty());
    let arguments_part = delta
        .function
        .as_ref()
        .and_then(|function| function.arguments.clone())
        .filter(|arguments| !arguments.is_empty());
    let has_id = delta
        .id
        .as_deref()
        .map(|id| !id.is_empty())
        .unwrap_or(false);

    if has_id || name.is_some() {
        // First chunk of this tool call: flush anything buffered early.
        let mut arguments = String::new();
        if let Some(buffered) = state.buffered_tool_args.remove(&index) {
            arguments.push_str(&buffered);
        }
        if let Some(part) = &arguments_part {
            arguments.push_str(part);
        }
        state.emitted_tool_calls.insert(index);
        state
            .pending
            .push_back(Ok(StreamedMessagePart::ToolCall(ToolCall {
                id: delta.id.unwrap_or_default(),
                name: name.unwrap_or_default(),
                arguments: if arguments.is_empty() {
                    None
                } else {
                    Some(arguments)
                },
                stream_index: Some(index),
            })));
    } else if state.emitted_tool_calls.contains(&index) {
        state
            .pending
            .push_back(Ok(StreamedMessagePart::ToolCallDelta {
                arguments_part,
                index: Some(index),
            }));
    } else if let Some(part) = arguments_part {
        state
            .buffered_tool_args
            .entry(index)
            .or_default()
            .push_str(&part);
    }
}

pub(crate) fn build_request_body(
    model: &str,
    system_prompt: &str,
    tools: &[Tool],
    history: &[Message],
) -> Value {
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    if !system_prompt.is_empty() {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    messages.extend(history_to_wire(history));

    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    body
}

/// Chat Completions rejects media on a `tool` message. The text stays on
/// the tool message so every `tool_call_id` is answered in place, and the
/// images (plus audio and video) are re-sent as one user message after the
/// tool group — the role this API accepts media on.
fn history_to_wire(history: &[Message]) -> Vec<Value> {
    let mut messages = Vec::with_capacity(history.len());
    let mut pending_media = Vec::new();
    for message in history {
        if message.role != Role::Tool {
            flush_tool_media(&mut messages, &mut pending_media);
            messages.push(message_to_wire(message));
            continue;
        }
        messages.push(message_to_wire(message));
        pending_media.extend(media_wire_parts(message));
    }
    flush_tool_media(&mut messages, &mut pending_media);
    messages
}

fn flush_tool_media(messages: &mut Vec<Value>, pending_media: &mut Vec<Value>) {
    if pending_media.is_empty() {
        return;
    }
    let parts = std::mem::take(pending_media);
    messages.push(json!({ "role": "user", "content": parts }));
}

fn media_wire_parts(message: &Message) -> Vec<Value> {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::ImageUrl { image_url } => Some(json!({
                "type": "image_url",
                "image_url": media_url_value(image_url),
            })),
            ContentPart::VideoUrl { video_url } => Some(json!({
                "type": "video_url",
                "video_url": media_url_value(video_url),
            })),
            ContentPart::AudioUrl { audio_url } => Some(json!({
                "type": "audio_url",
                "audio_url": media_url_value(audio_url),
            })),
            ContentPart::Text { .. } | ContentPart::Think { .. } => None,
        })
        .collect()
}

fn message_to_wire(message: &Message) -> Value {
    match message.role {
        Role::System => json!({ "role": "system", "content": message.text() }),
        Role::User => {
            let has_media = message.content.iter().any(|part| {
                matches!(
                    part,
                    ContentPart::ImageUrl { .. }
                        | ContentPart::VideoUrl { .. }
                        | ContentPart::AudioUrl { .. }
                )
            });
            if has_media {
                let parts: Vec<Value> = message
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(json!({ "type": "text", "text": text })),
                        ContentPart::ImageUrl { image_url } => Some(json!({
                            "type": "image_url",
                            "image_url": media_url_value(image_url),
                        })),
                        ContentPart::VideoUrl { video_url } => Some(json!({
                            "type": "video_url",
                            "video_url": media_url_value(video_url),
                        })),
                        ContentPart::AudioUrl { audio_url } => Some(json!({
                            "type": "audio_url",
                            "audio_url": media_url_value(audio_url),
                        })),
                        ContentPart::Think { .. } => None,
                    })
                    .collect();
                json!({ "role": "user", "content": parts })
            } else {
                json!({ "role": "user", "content": message.text() })
            }
        }
        Role::Assistant => {
            let text = message.text();
            let mut value = json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { json!(text) },
            });
            if !message.tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(
                    message
                        .tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments.clone().unwrap_or_default(),
                                }
                            })
                        })
                        .collect(),
                );
            }
            value
        }
        // Think parts are intentionally not echoed back: OpenAI-compatible
        // reasoners (DeepSeek and friends) reject or ignore historical
        // reasoning content.
        Role::Tool => json!({
            "role": "tool",
            "tool_call_id": message.tool_call_id.clone().unwrap_or_default(),
            "content": message.text(),
        }),
    }
}

/// `{ url, id? }` for an OpenAI-compatible media part (the id is omitted
/// when absent, mirroring the TS conversion).
fn media_url_value(media: &crate::message::ImageUrl) -> Value {
    match &media.id {
        Some(id) => json!({ "url": media.url, "id": id }),
        None => json!({ "url": media.url }),
    }
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

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    /// DeepSeek / Qwen-style reasoning field.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// Alternative reasoning field used by some gateways.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ChunkToolCall>>,
}

impl ChunkDelta {
    fn reasoning(&self) -> Option<&str> {
        self.reasoning_content
            .as_deref()
            .or(self.reasoning.as_deref())
    }
}

#[derive(Debug, Deserialize)]
struct ChunkToolCall {
    #[serde(default)]
    index: Option<u64>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ChunkFunction>,
}

#[derive(Debug, Deserialize)]
struct ChunkFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history_with_tool_result() -> Vec<Message> {
        vec![
            Message::user("read a.txt"),
            Message::assistant(
                vec![],
                vec![ToolCall::new(
                    "call_1",
                    "Read",
                    Some("{\"path\":\"a.txt\"}".to_string()),
                )],
            ),
            Message::tool_result("call_1", "hello"),
        ]
    }

    #[test]
    fn builds_openai_request_body() {
        let tools = vec![Tool {
            name: "Read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let body = build_request_body("gpt-4o", "be nice", &tools, &history_with_tool_result());

        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], true);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "be nice");
        assert_eq!(messages[1]["role"], "user");
        // assistant message carries tool_calls with null content
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], Value::Null);
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], "Read");
        // tool message answers the call
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], "call_1");
        assert_eq!(messages[3]["content"], "hello");
        // tool schema
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "Read");
    }

    #[test]
    fn omits_tools_field_when_empty() {
        let body = build_request_body("m", "s", &[], &[]);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn extracts_structured_api_error_message() {
        let body = r#"{"error":{"message":"rate limited","type":"rate_limit"}}"#;
        assert_eq!(extract_error_message(body), "rate limited");
        assert_eq!(extract_error_message(""), "(empty response body)");
        assert_eq!(extract_error_message("plain text"), "plain text");
    }

    #[test]
    fn rejects_provider_without_model() {
        let config = ProviderConfig {
            name: "p".to_string(),
            provider_type: crate::providers::ProviderType::OpenAi,
            model: "  ".to_string(),
            ..Default::default()
        };
        assert!(OpenAiChatProvider::new(config).is_err());
    }

    #[test]
    fn user_messages_with_media_use_content_arrays() {
        let message = Message {
            role: crate::message::Role::User,
            name: None,
            content: vec![
                ContentPart::Text {
                    text: "look".to_string(),
                },
                ContentPart::VideoUrl {
                    video_url: crate::message::ImageUrl {
                        url: "ms://file-1".to_string(),
                        id: Some("file-1".to_string()),
                    },
                },
            ],
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
            origin: None,
        };
        let wire = message_to_wire(&message);
        assert_eq!(wire["role"], "user");
        assert_eq!(
            wire["content"][0],
            json!({ "type": "text", "text": "look" })
        );
        assert_eq!(
            wire["content"][1],
            json!({ "type": "video_url", "video_url": { "url": "ms://file-1", "id": "file-1" } })
        );

        // Audio parts serialize with the same `{ url, id? }` shape.
        let audio = Message {
            role: crate::message::Role::User,
            name: None,
            content: vec![ContentPart::AudioUrl {
                audio_url: crate::message::ImageUrl {
                    url: "ms://audio-2".to_string(),
                    id: None,
                },
            }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
            origin: None,
        };
        let wire = message_to_wire(&audio);
        assert_eq!(
            wire["content"][0],
            json!({ "type": "audio_url", "audio_url": { "url": "ms://audio-2" } })
        );

        // Plain text messages keep the string form.
        let plain = message_to_wire(&Message::user("hi"));
        assert_eq!(plain["content"], "hi");
    }

    #[test]
    fn tool_result_images_are_redelivered_as_the_following_user_message() {
        // A screenshot has to reach the model, but Chat Completions refuses
        // media on `tool` messages. The text stays on the tool message and
        // the images follow the whole tool group as one user message.
        let history = vec![
            Message::user("Look at the window"),
            Message::assistant(
                vec![ContentPart::Text {
                    text: "Capturing.".to_string(),
                }],
                vec![
                    ToolCall::new("call_1", "add", Some("{}".to_string())),
                    ToolCall::new("call_2", "multiply", Some("{}".to_string())),
                ],
            ),
            Message::tool_result_parts(
                "call_1",
                vec![
                    ContentPart::Text {
                        text: "first".to_string(),
                    },
                    ContentPart::ImageUrl {
                        image_url: crate::message::ImageUrl {
                            url: "https://example.com/first.png".to_string(),
                            id: None,
                        },
                    },
                ],
            ),
            Message::tool_result_parts(
                "call_2",
                vec![
                    ContentPart::Text {
                        text: "second".to_string(),
                    },
                    ContentPart::ImageUrl {
                        image_url: crate::message::ImageUrl {
                            url: "https://example.com/second.png".to_string(),
                            id: None,
                        },
                    },
                    ContentPart::AudioUrl {
                        audio_url: crate::message::ImageUrl {
                            url: "https://example.com/second.mp3".to_string(),
                            id: None,
                        },
                    },
                ],
            ),
        ];
        let body = build_request_body("gpt-4o", "", &[], &history);
        let messages = body["messages"].as_array().unwrap();
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "assistant", "tool", "tool", "user"]);
        assert_eq!(messages[2]["content"], "first");
        assert_eq!(messages[2]["tool_call_id"], "call_1");
        assert!(messages[2]["content"].is_string());
        assert_eq!(messages[3]["content"], "second");
        assert_eq!(messages[3]["tool_call_id"], "call_2");
        assert_eq!(
            messages[4]["content"],
            json!([
                { "type": "image_url", "image_url": { "url": "https://example.com/first.png" } },
                { "type": "image_url", "image_url": { "url": "https://example.com/second.png" } },
                { "type": "audio_url", "audio_url": { "url": "https://example.com/second.mp3" } }
            ])
        );
        // The stored tool result still carries the image. Folding is a wire
        // conversion, not a rewrite of the conversation.
        assert!(matches!(
            history[2].content[1],
            ContentPart::ImageUrl { .. }
        ));
    }
}
