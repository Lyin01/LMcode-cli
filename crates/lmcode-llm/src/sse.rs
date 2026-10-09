//! Incremental Server-Sent Events parser.
//!
//! Hand-rolled because the streaming providers only need the `data` payloads
//! and a tiny, testable surface beats another dependency. Handles `\n` and
//! `\r\n` frame separators, multi-line `data` fields, comment lines, and
//! fields split across network chunks.

/// One complete SSE event.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    /// Value of the `event:` field, when present.
    pub event: Option<String>,
    /// Joined `data:` field values (multiple lines joined with `\n`).
    pub data: String,
}

/// Incremental parser: feed raw text chunks, receive complete events.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of text and return every complete event it produced.
    ///
    /// Incomplete trailing data stays buffered until the next chunk.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(chunk);
        if self.buffer.contains("\r\n") {
            // CRLF only ever separates SSE lines; JSON payloads escape real
            // carriage returns as the two-character sequence `\r`, so a plain
            // replacement is safe and keeps frame scanning simple.
            self.buffer = self.buffer.replace("\r\n", "\n");
        }

        let mut events = Vec::new();
        while let Some(frame_end) = self.buffer.find("\n\n") {
            let frame: String = self.buffer[..frame_end].to_string();
            self.buffer.drain(..frame_end + 2);
            if let Some(event) = parse_frame(&frame) {
                events.push(event);
            }
        }
        events
    }
}

fn parse_frame(frame: &str) -> Option<SseEvent> {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for line in frame.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => event_name = Some(value.to_string()),
            "data" => data_lines.push(value),
            // `id` and `retry` fields are not needed by the providers.
            _ => {}
        }
    }

    if data_lines.is_empty() && event_name.is_none() {
        return None;
    }
    Some(SseEvent {
        event: event_name,
        data: data_lines.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_event() {
        let mut parser = SseParser::new();
        let events = parser.push("data: hello\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello");
        assert_eq!(events[0].event, None);
    }

    #[test]
    fn buffers_events_split_across_chunks() {
        let mut parser = SseParser::new();
        assert!(parser.push("data: {\"a\":").is_empty());
        let events = parser.push("1}\n\ndata: second\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "{\"a\":1}");
        assert_eq!(events[1].data, "second");
    }

    #[test]
    fn joins_multiline_data_fields() {
        let mut parser = SseParser::new();
        let events = parser.push("data: line one\ndata: line two\n\n");
        assert_eq!(events[0].data, "line one\nline two");
    }

    #[test]
    fn handles_crlf_and_comments() {
        let mut parser = SseParser::new();
        let events = parser.push(": keep-alive\r\nevent: ping\r\ndata: pong\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("ping"));
        assert_eq!(events[0].data, "pong");
    }

    #[test]
    fn parses_done_sentinel() {
        let mut parser = SseParser::new();
        let events = parser.push("data: [DONE]\n\n");
        assert_eq!(events[0].data, "[DONE]");
    }
}
