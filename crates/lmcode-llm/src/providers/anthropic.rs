//! Anthropic Messages provider (streaming).
//!
//! Targets the `/v1/messages` SSE protocol: `content_block` deltas for text,
//! thinking, and `tool_use` input; `message_delta` for stop_reason and usage.
//! Mirrors the mapping in `packages/liumir/src/providers/anthropic.ts`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt};
use serde_json::{Value, json};

use crate::error::LlmError;
use crate::generate::map_finish_reason;
use crate::message::{ContentPart, Message, Role, StreamedMessagePart, ToolCall};
use crate::provider::{BoxStream, ChatProvider, GenerateOptions, StreamSummary, StreamedMessage};
use crate::providers::ProviderConfig;
use crate::sse::{SseEvent, SseParser};
use crate::tool::Tool;

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u64 = 8192;

/// Streaming provider for the Anthropic Messages API.
pub struct AnthropicProvider {
    name: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
}

impl AnthropicProvider {
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
impl ChatProvider for AnthropicProvider {
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
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));

        let mut request = self
            .client
            .post(&url)
            .header("accept", "text/event-stream")
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body);
        if let Some(api_key) = options.api_key.as_deref().or(self.api_key.as_deref()) {
            request = request.header("x-api-key", api_key);
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
    finished: bool,
    summary: Arc<Mutex<StreamSummary>>,
}

fn build_parts_stream(
    response: reqwest::Response,
    summary: Arc<Mutex<StreamSummary>>,
) -> BoxStream<Result<StreamedMessagePart, LlmError>> {
    let state = StreamState {
        byte_stream: Box::pin(response.bytes_stream()),
        parser: SseParser::new(),
        pending: VecDeque::new(),
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
                        handle_sse_event(&mut state, &event);
                        if state.finished {
                            break;
                        }
                    }
                }
            }
        }
    }))
}

fn handle_sse_event(state: &mut StreamState, event: &SseEvent) {
    let data = event.data.trim();
    if data.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(_) => return,
    };

    match value["type"].as_str().unwrap_or_default() {
        "message_start" => {
            let message = &value["message"];
            if let Some(id) = message["id"].as_str().filter(|id| !id.is_empty()) {
                state.summary.lock().unwrap().id = Some(id.to_string());
            }
            let usage = &message["usage"];
            let mut summary = state.summary.lock().unwrap();
            let mut tokens = summary.usage.unwrap_or_default();
            tokens.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
            tokens.cache_read_tokens = usage["cache_read_input_tokens"].as_u64();
            summary.usage = Some(tokens);
        }
        "content_block_start" => {
            let block = &value["content_block"];
            if block["type"] == "tool_use" {
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::ToolCall(ToolCall {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        arguments: None,
                        stream_index: value["index"].as_u64(),
                    })));
            }
        }
        "content_block_delta" => {
            let index = value["index"].as_u64();
            let delta = &value["delta"];
            match delta["type"].as_str().unwrap_or_default() {
                "text_delta" => {
                    if let Some(text) = delta["text"].as_str().filter(|text| !text.is_empty()) {
                        state.pending.push_back(Ok(StreamedMessagePart::Content(
                            ContentPart::Text {
                                text: text.to_string(),
                            },
                        )));
                    }
                }
                "thinking_delta" => {
                    if let Some(think) =
                        delta["thinking"].as_str().filter(|think| !think.is_empty())
                    {
                        state.pending.push_back(Ok(StreamedMessagePart::Content(
                            ContentPart::Think {
                                think: think.to_string(),
                                encrypted: None,
                            },
                        )));
                    }
                }
                "signature_delta" => {
                    if let Some(signature) = delta["signature"]
                        .as_str()
                        .filter(|signature| !signature.is_empty())
                    {
                        // Merges into the preceding thinking part (see
                        // `merge_in_place`), which attaches the signature.
                        state.pending.push_back(Ok(StreamedMessagePart::Content(
                            ContentPart::Think {
                                think: String::new(),
                                encrypted: Some(signature.to_string()),
                            },
                        )));
                    }
                }
                "input_json_delta" => {
                    state
                        .pending
                        .push_back(Ok(StreamedMessagePart::ToolCallDelta {
                            arguments_part: delta["partial_json"].as_str().map(str::to_string),
                            index,
                        }));
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(raw) = value["delta"]["stop_reason"]
                .as_str()
                .filter(|reason| !reason.is_empty())
            {
                let mut summary = state.summary.lock().unwrap();
                summary.finish_reason = Some(map_finish_reason(raw));
                summary.raw_finish_reason = Some(raw.to_string());
            }
            if let Some(output_tokens) = value["usage"]["output_tokens"].as_u64() {
                let mut summary = state.summary.lock().unwrap();
                let mut tokens = summary.usage.unwrap_or_default();
                tokens.output_tokens = output_tokens;
                summary.usage = Some(tokens);
            }
        }
        "error" => {
            let message = value["error"]["message"]
                .as_str()
                .unwrap_or("stream error")
                .to_string();
            state.pending.push_back(Err(LlmError::Stream(message)));
            state.finished = true;
        }
        "message_stop" => {
            state.finished = true;
        }
        // `ping`, `content_block_stop` carry nothing the port needs.
        _ => {}
    }
}

fn build_request_body(
    model: &str,
    system_prompt: &str,
    tools: &[Tool],
    history: &[Message],
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "messages": build_messages(history),
        "stream": true,
    });
    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
}

fn build_messages(history: &[Message]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut last_was_tool_results = false;
    for message in history {
        if message.role == Role::Tool {
            let block = json!({
                "type": "tool_result",
                "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                "content": message.text(),
            });
            // Consecutive tool results collapse into one user message.
            if last_was_tool_results
                && let Some(content) = messages
                    .last_mut()
                    .and_then(|last| last["content"].as_array_mut())
            {
                content.push(block);
            } else {
                messages.push(json!({ "role": "user", "content": [block] }));
                last_was_tool_results = true;
            }
            continue;
        }
        last_was_tool_results = false;
        match message.role {
            Role::User => {
                let blocks = user_blocks(message);
                if !blocks.is_empty() {
                    messages.push(json!({ "role": "user", "content": blocks }));
                }
            }
            Role::Assistant => {
                let blocks = assistant_blocks(message);
                if !blocks.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            _ => {}
        }
    }
    messages
}

fn user_blocks(message: &Message) -> Vec<Value> {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(json!({ "type": "text", "text": text })),
            // Images land in a later batch (needs media-type handling).
            _ => None,
        })
        .collect()
}

fn assistant_blocks(message: &Message) -> Vec<Value> {
    let mut blocks = Vec::new();
    for part in &message.content {
        match part {
            ContentPart::Think { think, encrypted } => {
                // Thinking blocks are preserved; the signature is included
                // only when the provider supplied one.
                let mut block = json!({ "type": "thinking", "thinking": think });
                if let Some(signature) = encrypted {
                    block["signature"] = json!(signature);
                }
                blocks.push(block);
            }
            ContentPart::Text { text } => blocks.push(json!({ "type": "text", "text": text })),
            _ => {}
        }
    }
    for call in &message.tool_calls {
        let input: Value = call
            .arguments
            .as_deref()
            .and_then(|arguments| serde_json::from_str(arguments).ok())
            .unwrap_or_else(|| json!({}));
        blocks.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": input,
        }));
    }
    blocks
}

fn extract_error_message(body: &str) -> String {
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
    fn builds_messages_with_merged_tool_results() {
        let history = vec![
            Message::user("read a.txt and b.txt"),
            Message::assistant(
                vec![],
                vec![
                    ToolCall::new("call_a", "Read", Some("{\"path\":\"a.txt\"}".to_string())),
                    ToolCall::new("call_b", "Read", Some("{\"path\":\"b.txt\"}".to_string())),
                ],
            ),
            Message::tool_result("call_a", "content-a"),
            Message::tool_result("call_b", "content-b"),
        ];
        let messages = build_messages(&history);
        assert_eq!(
            messages.len(),
            3,
            "two tool results merge into one user message"
        );
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");
        assert_eq!(messages[1]["content"][0]["input"]["path"], "a.txt");
        assert_eq!(messages[2]["role"], "user");
        let blocks = messages[2]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[0]["tool_use_id"], "call_a");
        assert_eq!(blocks[1]["tool_use_id"], "call_b");
    }

    #[test]
    fn preserves_thinking_with_optional_signature() {
        let message = Message::assistant(
            vec![
                ContentPart::Think {
                    think: "signed".to_string(),
                    encrypted: Some("sig-1".to_string()),
                },
                ContentPart::Think {
                    think: "unsigned".to_string(),
                    encrypted: None,
                },
            ],
            vec![],
        );
        let blocks = assistant_blocks(&message);
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["signature"], "sig-1");
        assert!(blocks[1].get("signature").is_none());
    }

    #[test]
    fn request_body_carries_system_tools_and_stream_flag() {
        let tools = vec![Tool {
            name: "Read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let body = build_request_body(
            "claude-sonnet-4-5",
            "be nice",
            &tools,
            &[Message::user("hi")],
        );
        assert_eq!(body["model"], "claude-sonnet-4-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "be nice");
        assert_eq!(body["tools"][0]["name"], "Read");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
    }
}
