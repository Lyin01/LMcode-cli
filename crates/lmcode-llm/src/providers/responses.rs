//! OpenAI Responses provider (streaming).
//!
//! Targets the `/responses` SSE protocol (`response.*` events) used by the
//! newer OpenAI API and compatible gateways. Mirrors the mapping in
//! `packages/liumir/src/providers/openai-responses.ts`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt};
use serde_json::{Value, json};

use crate::error::LlmError;
use crate::generate::map_finish_reason;
use crate::message::{ContentPart, Message, Role, StreamedMessagePart, ToolCall};
use crate::provider::{
    BoxStream, ChatProvider, FinishReason, GenerateOptions, StreamSummary, StreamedMessage,
};
use crate::providers::ProviderConfig;
use crate::sse::{SseEvent, SseParser};
use crate::tool::Tool;
use crate::usage::TokenUsage;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Streaming provider for the OpenAI Responses API.
pub struct ResponsesProvider {
    name: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
}

impl ResponsesProvider {
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
impl ChatProvider for ResponsesProvider {
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
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));

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
        "response.created" | "response.in_progress" => {
            if let Some(id) = value["response"]["id"].as_str().filter(|id| !id.is_empty()) {
                state.summary.lock().unwrap().id = Some(id.to_string());
            }
        }
        "response.output_text.delta" => {
            if let Some(delta) = value["delta"].as_str().filter(|delta| !delta.is_empty()) {
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::Content(ContentPart::Text {
                        text: delta.to_string(),
                    })));
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let Some(delta) = value["delta"].as_str().filter(|delta| !delta.is_empty()) {
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::Content(ContentPart::Think {
                        think: delta.to_string(),
                        encrypted: None,
                    })));
            }
        }
        "response.output_item.added" => {
            let item = &value["item"];
            if item["type"] == "function_call" {
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::ToolCall(ToolCall {
                        id: item["call_id"].as_str().unwrap_or_default().to_string(),
                        name: item["name"].as_str().unwrap_or_default().to_string(),
                        arguments: item["arguments"]
                            .as_str()
                            .filter(|arguments| !arguments.is_empty())
                            .map(str::to_string),
                        // Parallel calls get distinct output indices; deltas
                        // route by the same key.
                        stream_index: value["output_index"].as_u64(),
                    })));
            }
        }
        "response.function_call_arguments.delta" => {
            if let Some(delta) = value["delta"].as_str().filter(|delta| !delta.is_empty()) {
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::ToolCallDelta {
                        arguments_part: Some(delta.to_string()),
                        index: value["output_index"].as_u64(),
                    }));
            }
        }
        "response.output_item.done" => {
            let item = &value["item"];
            if item["type"] == "reasoning"
                && let Some(encrypted) = item["encrypted_content"]
                    .as_str()
                    .filter(|encrypted| !encrypted.is_empty())
            {
                // Attaches to the preceding thinking run via merge.
                state
                    .pending
                    .push_back(Ok(StreamedMessagePart::Content(ContentPart::Think {
                        think: String::new(),
                        encrypted: Some(encrypted.to_string()),
                    })));
            }
        }
        "response.completed" | "response.incomplete" => {
            let response = &value["response"];
            let usage = &response["usage"];
            if !usage.is_null() {
                state.summary.lock().unwrap().usage = Some(TokenUsage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: usage["input_tokens_details"]["cached_tokens"].as_u64(),
                });
            }
            let mut summary = state.summary.lock().unwrap();
            if value["type"] == "response.incomplete" {
                let reason = response["incomplete_details"]["reason"]
                    .as_str()
                    .unwrap_or("max_output_tokens");
                summary.finish_reason = Some(map_finish_reason(reason));
                summary.raw_finish_reason = Some(reason.to_string());
            } else {
                summary.finish_reason = Some(FinishReason::Completed);
                summary.raw_finish_reason = Some("completed".to_string());
            }
            drop(summary);
            state.finished = true;
        }
        "response.failed" => {
            let message = value["response"]["error"]["message"]
                .as_str()
                .unwrap_or("response failed")
                .to_string();
            state.pending.push_back(Err(LlmError::Stream(message)));
            state.finished = true;
        }
        "error" => {
            let message = value["message"]
                .as_str()
                .or_else(|| value["error"]["message"].as_str())
                .unwrap_or("stream error")
                .to_string();
            state.pending.push_back(Err(LlmError::Stream(message)));
            state.finished = true;
        }
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
        "input": build_input(history),
        "stream": true,
        "store": false,
    });
    if !system_prompt.is_empty() {
        body["instructions"] = json!(system_prompt);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
}

fn build_input(history: &[Message]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in history {
        match message.role {
            Role::User => {
                let text = message.text();
                if !text.is_empty() {
                    items.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": text }],
                    }));
                }
            }
            Role::Assistant => {
                let text = message.text();
                if !text.is_empty() {
                    items.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                for call in &message.tool_calls {
                    items.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments.clone().unwrap_or_default(),
                    }));
                }
                // Think parts are not replayed: reasoning items require
                // encrypted_content, which is intentionally not persisted.
            }
            Role::Tool => {
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": message.tool_call_id.clone().unwrap_or_default(),
                    "output": message.text(),
                }));
            }
            _ => {}
        }
    }
    items
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
    fn builds_input_items_for_a_tool_round_trip() {
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
        ];
        let items = build_input(&history);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["type"], "message");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["content"][0]["type"], "input_text");
        assert_eq!(items[1]["type"], "function_call");
        assert_eq!(items[1]["call_id"], "call_1");
        assert_eq!(items[1]["name"], "Read");
        assert_eq!(items[2]["type"], "function_call_output");
        assert_eq!(items[2]["call_id"], "call_1");
        assert_eq!(items[2]["output"], "file-content");
    }

    #[test]
    fn request_body_uses_instructions_and_flat_tools() {
        let tools = vec![Tool {
            name: "Read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let body = build_request_body("gpt-5", "be nice", &tools, &[Message::user("hi")]);
        assert_eq!(body["instructions"], "be nice");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "Read");
        assert!(body["tools"][0].get("function").is_none());
    }
}
