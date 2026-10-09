//! Diff-aware rendering for tool results in the transcript.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::markdown::wrap_spans;

/// Maximum number of result lines rendered under a tool call.
const MAX_RESULT_LINES: usize = 30;

/// Heuristic: does the text look like a unified diff?
pub fn is_diff(text: &str) -> bool {
    let mut changed = 0;
    for line in text.lines().take(40) {
        let is_change = (line.starts_with('+') && !line.starts_with("+++"))
            || (line.starts_with('-') && !line.starts_with("---"));
        if is_change {
            changed += 1;
        }
    }
    changed >= 2
}

/// Render tool-result text under a tool line, colourising diff content when
/// present. Plain output is shown dimmed.
pub fn render_tool_result(text: &str, width: usize) -> Vec<Line<'static>> {
    if text.is_empty() {
        return Vec::new();
    }
    let diff = is_diff(text);
    let mut lines = Vec::new();
    for raw_line in text.lines().take(MAX_RESULT_LINES) {
        let style = line_style(raw_line, diff);
        lines.extend(wrap_spans(
            vec![Span::styled(format!("    {raw_line}"), style)],
            width,
        ));
    }
    let total = text.lines().count();
    if total > MAX_RESULT_LINES {
        lines.push(Line::from(Span::styled(
            format!("    … ({total} lines total)"),
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines
}

fn line_style(line: &str, diff: bool) -> Style {
    if !diff {
        return Style::default().fg(Color::DarkGray);
    }
    if line.starts_with("@@") {
        return Style::default().fg(Color::Cyan);
    }
    if line.starts_with("+++") || line.starts_with("---") {
        return Style::default().add_modifier(Modifier::BOLD);
    }
    if line.starts_with('+') {
        return Style::default().fg(Color::Green);
    }
    if line.starts_with('-') {
        return Style::default().fg(Color::Red);
    }
    Style::default().fg(Color::DarkGray)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_unified_diff() {
        assert!(is_diff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"));
        assert!(!is_diff("plain output\nsecond line"));
        // A single lone marker is not enough to treat text as a diff.
        assert!(!is_diff("+ one bullet"));
        assert!(!is_diff("--- title\nbody"));
    }

    #[test]
    fn diff_lines_get_semantic_colours() {
        let lines = render_tool_result("@@ -1 +1 @@\n-old\n+new", 40);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].spans[0].style.fg, Some(Color::Cyan));
        assert_eq!(lines[1].spans[0].style.fg, Some(Color::Red));
        assert_eq!(lines[2].spans[0].style.fg, Some(Color::Green));
    }

    #[test]
    fn plain_output_is_dimmed() {
        let lines = render_tool_result("hello", 40);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].spans[0].style.fg, Some(Color::DarkGray));
        assert!(lines[0].spans[0].content.starts_with("    hello"));
    }

    #[test]
    fn long_output_is_capped() {
        let text = (0..MAX_RESULT_LINES + 5)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let lines = render_tool_result(&text, 80);
        assert_eq!(lines.len(), MAX_RESULT_LINES + 1); // capped + summary line
        assert!(
            lines.last().unwrap().spans[0]
                .content
                .contains("lines total")
        );
    }

    #[test]
    fn empty_result_renders_nothing() {
        assert!(render_tool_result("", 40).is_empty());
    }
}
