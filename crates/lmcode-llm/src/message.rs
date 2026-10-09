//! Conversation message model — mirrors `packages/liumir/src/message.ts`.
//!
//! Wire shape of the serde representation intentionally follows the TypeScript
//! types (`type` tags, camelCase payload fields) so the two implementations can
//! interoperate over IPC while the migration is in progress.

use serde::{Deserialize, Serialize};

/// Role of a message sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Payload of an `image_url` content part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// A single piece of content within a [`Message`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Think {
        think: String,
        /// Provider-specific reasoning signature.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted: Option<String>,
    },
    ImageUrl {
        #[serde(rename = "imageUrl")]
        image_url: ImageUrl,
    },
    /// LMcode-hosted video reference (`ms://<file-id>`), produced by
    /// [`crate::providers::lmcode::LmcodeProvider::upload_video`].
    VideoUrl {
        #[serde(rename = "videoUrl")]
        video_url: ImageUrl,
    },
    /// Audio reference (`audio_url` in the TS wire format).
    AudioUrl {
        #[serde(rename = "audioUrl")]
        audio_url: ImageUrl,
    },
}

/// A tool call requested by the assistant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    /// Provider streaming index used to route argument deltas to the correct
    /// parallel tool call. Internal — never serialized.
    #[serde(skip)]
    pub stream_index: Option<u64>,
}

impl ToolCall {
    /// Create a tool call without a streaming index.
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Option<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments,
            stream_index: None,
        }
    }
}

/// A single message in a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub content: Vec<ContentPart>,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(
        default,
        rename = "toolCallId",
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

impl Message {
    /// Create a user message with a single text part.
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            name: None,
            content: vec![ContentPart::Text { text: text.into() }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
        }
    }

    /// Create a user message from text plus image URLs.
    pub fn user_with_images(text: impl Into<String>, images: &[String]) -> Self {
        let mut content = vec![ContentPart::Text { text: text.into() }];
        for image in images {
            content.push(ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: image.clone(),
                    id: None,
                },
            });
        }
        Self {
            role: Role::User,
            name: None,
            content,
            tool_calls: Vec::new(),
            tool_call_id: None,
            partial: None,
        }
    }

    /// Create an assistant message from content parts and tool calls.
    pub fn assistant(content: Vec<ContentPart>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: Role::Assistant,
            name: None,
            content,
            tool_calls,
            tool_call_id: None,
            partial: None,
        }
    }

    /// Create a tool-result message answering the given tool call.
    pub fn tool_result(tool_call_id: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            name: None,
            content: vec![ContentPart::Text {
                text: output.into(),
            }],
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            partial: None,
        }
    }

    /// Concatenated text of all `text` content parts.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

/// A single chunk yielded by a [`crate::provider::StreamedMessage`].
///
/// The stream carries content deltas, tool-call starts, and tool-call argument
/// deltas. Completion is inferred from stream end (and `finish_reason` on the
/// summary), not from a dedicated done event.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamedMessagePart {
    Content(ContentPart),
    ToolCall(ToolCall),
    ToolCallDelta {
        arguments_part: Option<String>,
        index: Option<u64>,
    },
}

/// Merge `source` into `target` in-place for streaming accumulation.
///
/// Supported combinations (mirrors `mergeInPlace` in the TS implementation):
/// - `Text` + `Text` → concatenate
/// - `Think` + `Think` → concatenate (refuses once `target.encrypted` is set)
/// - `ToolCall` + `ToolCallDelta` → append arguments
///
/// Returns `true` when a merge was performed.
pub fn merge_in_place(target: &mut StreamedMessagePart, source: &StreamedMessagePart) -> bool {
    match (target, source) {
        (
            StreamedMessagePart::Content(ContentPart::Text { text }),
            StreamedMessagePart::Content(ContentPart::Text { text: source_text }),
        ) => {
            text.push_str(source_text);
            true
        }
        (
            StreamedMessagePart::Content(ContentPart::Think { think, encrypted }),
            StreamedMessagePart::Content(ContentPart::Think {
                think: source_think,
                encrypted: source_encrypted,
            }),
        ) => {
            if encrypted.is_some() {
                return false;
            }
            think.push_str(source_think);
            if source_encrypted.is_some() {
                *encrypted = source_encrypted.clone();
            }
            true
        }
        (
            StreamedMessagePart::ToolCall(call),
            StreamedMessagePart::ToolCallDelta { arguments_part, .. },
        ) => {
            if let Some(part) = arguments_part {
                match &mut call.arguments {
                    None => call.arguments = Some(part.clone()),
                    Some(arguments) => arguments.push_str(part),
                }
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> StreamedMessagePart {
        StreamedMessagePart::Content(ContentPart::Text {
            text: value.to_string(),
        })
    }

    #[test]
    fn merges_adjacent_text_parts() {
        let mut target = text("Hel");
        assert!(merge_in_place(&mut target, &text("lo")));
        assert_eq!(target, text("Hello"));
    }

    #[test]
    fn merges_tool_call_arguments() {
        let mut target = StreamedMessagePart::ToolCall(ToolCall::new("1", "Read", None));
        let delta = StreamedMessagePart::ToolCallDelta {
            arguments_part: Some("{\"path\"".to_string()),
            index: Some(0),
        };
        assert!(merge_in_place(&mut target, &delta));
        assert!(merge_in_place(
            &mut target,
            &StreamedMessagePart::ToolCallDelta {
                arguments_part: Some(": \"a.txt\"}".to_string()),
                index: Some(0),
            }
        ));
        match target {
            StreamedMessagePart::ToolCall(call) => {
                assert_eq!(call.arguments.as_deref(), Some("{\"path\": \"a.txt\"}"));
            }
            other => panic!("expected tool call, got {other:?}"),
        }
    }

    #[test]
    fn refuses_to_merge_think_once_encrypted() {
        let mut target = StreamedMessagePart::Content(ContentPart::Think {
            think: "a".to_string(),
            encrypted: Some("sig".to_string()),
        });
        let source = StreamedMessagePart::Content(ContentPart::Think {
            think: "b".to_string(),
            encrypted: None,
        });
        assert!(!merge_in_place(&mut target, &source));
    }

    #[test]
    fn user_with_images_builds_text_plus_image_parts() {
        let message = Message::user_with_images("look", &["file:///a.png".to_string()]);
        assert_eq!(message.content.len(), 2);
        assert!(matches!(&message.content[0], ContentPart::Text { text } if text == "look"));
        match &message.content[1] {
            ContentPart::ImageUrl { image_url } => {
                assert_eq!(image_url.url, "file:///a.png");
                assert!(image_url.id.is_none());
            }
            other => panic!("expected ImageUrl, got {other:?}"),
        }
    }
}
