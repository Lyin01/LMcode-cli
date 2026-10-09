//! Stream assembly and finish-reason mapping — mirrors the merge loop in
//! `packages/liumir/src/generate.ts`.

use crate::message::{ContentPart, StreamedMessagePart, ToolCall, merge_in_place};
use crate::provider::FinishReason;

/// Assemble streamed parts into final content parts and tool calls.
///
/// Tool-call argument deltas are routed to the matching pending [`ToolCall`]
/// by their streaming `index` (parallel tool calls interleave their deltas);
/// when no index is available they fall back to the most recent tool call.
pub fn assemble_parts(
    parts: impl IntoIterator<Item = StreamedMessagePart>,
) -> (Vec<ContentPart>, Vec<ToolCall>) {
    let mut merged: Vec<StreamedMessagePart> = Vec::new();
    for part in parts {
        match part {
            StreamedMessagePart::ToolCallDelta {
                arguments_part,
                index,
            } => route_tool_call_delta(&mut merged, arguments_part, index),
            other => {
                if let Some(last) = merged.last_mut()
                    && merge_in_place(last, &other)
                {
                    continue;
                }
                merged.push(other);
            }
        }
    }

    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for part in merged {
        match part {
            StreamedMessagePart::Content(part) => content.push(part),
            StreamedMessagePart::ToolCall(mut call) => {
                call.stream_index = None;
                tool_calls.push(call);
            }
            StreamedMessagePart::ToolCallDelta { .. } => {}
        }
    }
    (content, tool_calls)
}

fn route_tool_call_delta(
    merged: &mut [StreamedMessagePart],
    arguments_part: Option<String>,
    index: Option<u64>,
) {
    if let Some(index) = index
        && let Some(target) = merged.iter_mut().rfind(
            |part| matches!(part, StreamedMessagePart::ToolCall(call) if call.stream_index == Some(index)),
        )
        && let StreamedMessagePart::ToolCall(call) = target
    {
        append_arguments(call, &arguments_part);
        return;
    }

    // Sequential fallback: merge into the most recent tool call.
    if let Some(last) = merged.last_mut()
        && matches!(last, StreamedMessagePart::ToolCall(_))
        && let StreamedMessagePart::ToolCall(call) = last
    {
        append_arguments(call, &arguments_part);
    }
    // No pending tool call to route to — drop the delta.
}

fn append_arguments(call: &mut ToolCall, arguments_part: &Option<String>) {
    if let Some(part) = arguments_part {
        match &mut call.arguments {
            None => call.arguments = Some(part.clone()),
            Some(arguments) => arguments.push_str(part),
        }
    }
}

/// Map a provider-native `finish_reason` string to the normalized enum.
///
/// Covers OpenAI (`stop`, `length`, `content_filter`, `tool_calls`),
/// Anthropic (`end_turn`, `max_tokens`, `tool_use`, `pause_turn`), and
/// Responses-style (`completed`, `max_output_tokens`) values.
pub fn map_finish_reason(raw: &str) -> FinishReason {
    match raw {
        "stop" | "end_turn" | "stop_sequence" | "completed" => FinishReason::Completed,
        "tool_calls" | "tool_use" | "function_call" => FinishReason::ToolCalls,
        "length" | "max_tokens" | "max_output_tokens" => FinishReason::Truncated,
        "content_filter" | "refusal" => FinishReason::Filtered,
        "pause_turn" => FinishReason::Paused,
        _ => FinishReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::ContentPart;

    fn text(value: &str) -> StreamedMessagePart {
        StreamedMessagePart::Content(ContentPart::Text {
            text: value.to_string(),
        })
    }

    fn think(value: &str) -> StreamedMessagePart {
        StreamedMessagePart::Content(ContentPart::Think {
            think: value.to_string(),
            encrypted: None,
        })
    }

    fn call(index: u64, name: &str) -> StreamedMessagePart {
        StreamedMessagePart::ToolCall(ToolCall {
            id: format!("call_{index}"),
            name: name.to_string(),
            arguments: None,
            stream_index: Some(index),
        })
    }

    fn delta(index: Option<u64>, arguments: &str) -> StreamedMessagePart {
        StreamedMessagePart::ToolCallDelta {
            arguments_part: Some(arguments.to_string()),
            index,
        }
    }

    #[test]
    fn assembles_text_and_think_in_order() {
        let parts = vec![think("hmm"), think("..."), text("Hel"), text("lo")];
        let (content, calls) = assemble_parts(parts);
        assert!(calls.is_empty());
        assert_eq!(
            content,
            vec![
                ContentPart::Think {
                    think: "hmm...".to_string(),
                    encrypted: None,
                },
                ContentPart::Text {
                    text: "Hello".to_string(),
                },
            ]
        );
    }

    #[test]
    fn assembles_single_tool_call_arguments() {
        let parts = vec![
            call(0, "Read"),
            delta(Some(0), "{\"path\":"),
            delta(Some(0), "\"a.txt\"}"),
        ];
        let (content, calls) = assemble_parts(parts);
        assert!(content.is_empty());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"path\":\"a.txt\"}"));
        assert_eq!(calls[0].stream_index, None, "stream index must be stripped");
    }

    #[test]
    fn routes_interleaved_parallel_tool_call_deltas() {
        let parts = vec![
            call(0, "Read"),
            call(1, "Bash"),
            delta(Some(1), "{\"command\":\"l"),
            delta(Some(0), "{\"path\":\"b.txt\"}"),
            delta(Some(1), "s\"}"),
        ];
        let (_, calls) = assemble_parts(parts);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"path\":\"b.txt\"}"));
        assert_eq!(calls[1].name, "Bash");
        assert_eq!(calls[1].arguments.as_deref(), Some("{\"command\":\"ls\"}"));
    }

    #[test]
    fn falls_back_to_last_tool_call_without_index() {
        let parts = vec![call(0, "Read"), delta(None, "{}")];
        let (_, calls) = assemble_parts(parts);
        assert_eq!(calls[0].arguments.as_deref(), Some("{}"));
    }

    #[test]
    fn maps_known_finish_reasons() {
        assert_eq!(map_finish_reason("stop"), FinishReason::Completed);
        assert_eq!(map_finish_reason("tool_calls"), FinishReason::ToolCalls);
        assert_eq!(map_finish_reason("length"), FinishReason::Truncated);
        assert_eq!(map_finish_reason("content_filter"), FinishReason::Filtered);
        assert_eq!(map_finish_reason("end_turn"), FinishReason::Completed);
        assert_eq!(map_finish_reason("max_tokens"), FinishReason::Truncated);
        assert_eq!(map_finish_reason("something_new"), FinishReason::Other);
    }
}
