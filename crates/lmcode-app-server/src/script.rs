//! Offline provider for `lm app-server`.
//!
//! `script` echoes the latest real user prompt. `script-bash` and `script-ask`
//! emit one tool call on the first request. `script-pause` waits inside the
//! stream so a client can steer or interrupt before the token arrives.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::stream;

use lmcode_llm::provider::{
    BoxStream, ChatProvider, FinishReason, GenerateOptions, StreamSummary, StreamedMessage,
};
use lmcode_llm::{ContentPart, LlmError, Message, StreamedMessagePart, ToolCall};

pub struct ScriptProvider {
    model: String,
    calls: AtomicUsize,
}

impl ScriptProvider {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ChatProvider for ScriptProvider {
    fn name(&self) -> &str {
        "script"
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    async fn generate(
        &self,
        _system_prompt: &str,
        _tools: &[lmcode_llm::Tool],
        history: &[Message],
        _options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let last_user = history
            .iter()
            .rev()
            .find(|message| message.is_real_user_prompt())
            .map(Message::text)
            .unwrap_or_default();
        let part = if self.model == "script-bash" && call == 0 {
            StreamedMessagePart::ToolCall(ToolCall::new(
                "call-bash",
                "Bash",
                Some(r#"{"command":"echo hi"}"#.to_string()),
            ))
        } else if self.model == "script-ask" && call == 0 {
            StreamedMessagePart::ToolCall(ToolCall::new(
                "call-ask",
                "AskUserQuestion",
                Some(
                    r#"{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"one"},{"label":"B","description":"two"}]}]}"#
                        .to_string(),
                ),
            ))
        } else {
            StreamedMessagePart::Content(ContentPart::Text {
                text: format!("script: {last_user}"),
            })
        };
        let pause = self.model == "script-pause" && call == 0;
        let parts: BoxStream<Result<StreamedMessagePart, LlmError>> =
            Box::pin(stream::once(async move {
                if pause {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                }
                Ok(part)
            }));
        let summary = Arc::new(Mutex::new(StreamSummary {
            finish_reason: Some(FinishReason::Completed),
            ..StreamSummary::default()
        }));
        Ok(StreamedMessage::new(parts, summary))
    }
}
