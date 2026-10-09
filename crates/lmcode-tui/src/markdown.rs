//! Minimal markdown rendering for assistant text.
//!
//! Line-level constructs (headings, fenced code blocks, lists) plus inline
//! spans (bold, inline code). Wrapping flattens spans to styled characters
//! and rebuilds them per line so styles survive line breaks.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthChar;

fn heading_style() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD)
}

fn code_block_style() -> Style {
    Style::default().fg(Color::DarkGray)
}

fn inline_code_style() -> Style {
    Style::default().fg(Color::Yellow)
}

fn bold_style() -> Style {
    Style::default().add_modifier(Modifier::BOLD)
}

/// Render markdown text into styled lines wrapped to `width` columns.
pub fn render_markdown(text: &str, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut in_code_block = false;

    for raw_line in text.split('\n') {
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            lines.extend(wrap_spans(
                vec![Span::styled(format!("  {raw_line}"), code_block_style())],
                width,
            ));
            continue;
        }
        if let Some(heading) = parse_heading(trimmed) {
            lines.extend(wrap_spans(
                vec![Span::styled(heading.to_string(), heading_style())],
                width,
            ));
            continue;
        }
        if let Some(item) = parse_list_item(trimmed) {
            let mut spans = vec![Span::styled("• ", Style::default().fg(Color::DarkGray))];
            spans.extend(inline_spans(item));
            lines.extend(wrap_spans(spans, width));
            continue;
        }
        lines.extend(wrap_spans(inline_spans(raw_line), width));
    }
    lines
}

/// `# heading` → heading text (1–6 hashes).
fn parse_heading(line: &str) -> Option<&str> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = line[hashes..].trim_start();
    if rest.is_empty() { None } else { Some(rest) }
}

/// `- item` / `* item` → item text.
fn parse_list_item(line: &str) -> Option<&str> {
    line.strip_prefix("- ").or_else(|| line.strip_prefix("* "))
}

/// Split a line into styled spans: `**bold**` and `` `code` `` runs.
fn inline_spans(text: &str) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut buffer = String::new();
    let mut chars = text.chars().peekable();

    let flush = |spans: &mut Vec<Span<'static>>, buffer: &mut String| {
        if !buffer.is_empty() {
            spans.push(Span::raw(std::mem::take(buffer)));
        }
    };

    while let Some(character) = chars.next() {
        if character == '`' {
            let mut code = String::new();
            let mut closed = false;
            for next in chars.by_ref() {
                if next == '`' {
                    closed = true;
                    break;
                }
                code.push(next);
            }
            if closed {
                flush(&mut spans, &mut buffer);
                spans.push(Span::styled(code, inline_code_style()));
            } else {
                buffer.push('`');
                buffer.push_str(&code);
            }
        } else if character == '*' && chars.peek() == Some(&'*') {
            chars.next();
            let mut bold = String::new();
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == '*' && chars.peek() == Some(&'*') {
                    chars.next();
                    closed = true;
                    break;
                }
                bold.push(next);
            }
            if closed {
                flush(&mut spans, &mut buffer);
                spans.push(Span::styled(bold, bold_style()));
            } else {
                buffer.push_str("**");
                buffer.push_str(&bold);
            }
        } else {
            buffer.push(character);
        }
    }
    flush(&mut spans, &mut buffer);
    spans
}

/// Wrap styled spans to `width` display columns, preserving styles across
/// line breaks.
pub fn wrap_spans(spans: Vec<Span<'static>>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();
    let mut current_width = 0usize;

    for span in spans {
        let style = span.style;
        for character in span.content.chars() {
            let character_width = UnicodeWidthChar::width(character).unwrap_or(1).max(1);
            if current_width + character_width > width && current_width > 0 {
                lines.push(Line::from(std::mem::take(&mut current)));
                current_width = 0;
            }
            match current.last_mut() {
                Some(last) if last.style == style => last.content.to_mut().push(character),
                _ => current.push(Span::styled(character.to_string(), style)),
            }
            current_width += character_width;
        }
    }
    if !current.is_empty() {
        lines.push(Line::from(current));
    }
    if lines.is_empty() {
        lines.push(Line::default());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headings_and_list_items() {
        assert_eq!(parse_heading("## Title"), Some("Title"));
        assert_eq!(parse_heading("#NoSpace"), Some("NoSpace"));
        assert_eq!(parse_heading("####### too many"), None);
        assert_eq!(parse_heading("plain"), None);
        assert_eq!(parse_list_item("- item"), Some("item"));
        assert_eq!(parse_list_item("* item"), Some("item"));
        assert_eq!(parse_list_item("1. ordered"), None);
    }

    #[test]
    fn inline_spans_handle_bold_and_code() {
        let spans = inline_spans("a **bold** b `code` c");
        let texts: Vec<String> = spans.iter().map(|span| span.content.to_string()).collect();
        assert_eq!(texts, vec!["a ", "bold", " b ", "code", " c"]);
        assert!(spans[1].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(spans[3].style.fg, Some(Color::Yellow));
    }

    #[test]
    fn inline_spans_keep_unclosed_markers_literal() {
        let spans = inline_spans("a **unclosed");
        let joined: String = spans.iter().map(|span| span.content.to_string()).collect();
        assert_eq!(joined, "a **unclosed");
        let spans = inline_spans("a `unclosed");
        let joined: String = spans.iter().map(|span| span.content.to_string()).collect();
        assert_eq!(joined, "a `unclosed");
    }

    #[test]
    fn wrap_spans_preserves_styles_across_breaks() {
        let spans = vec![Span::styled("abcdef", bold_style())];
        let lines = wrap_spans(spans, 3);
        assert_eq!(lines.len(), 2);
        let first: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert_eq!(first, "abc");
        assert!(
            lines[1].spans[0]
                .style
                .add_modifier
                .contains(Modifier::BOLD),
            "style survives the line break"
        );
    }

    #[test]
    fn renders_headings_lists_and_code_blocks() {
        let markdown = "# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```\nlet x = 1;\n```\n";
        let lines = render_markdown(markdown, 40);
        let flat: Vec<String> = lines
            .iter()
            .map(|line| line.spans.iter().map(|s| s.content.to_string()).collect())
            .collect();
        assert!(flat.iter().any(|line| line == "Title"));
        assert!(
            flat.iter()
                .any(|line| line.contains("Some ") && line.contains("bold"))
        );
        assert!(flat.iter().any(|line| line == "• one"));
        assert!(flat.iter().any(|line| line.contains("let x = 1;")));
        assert!(
            !flat.iter().any(|line| line.contains("```")),
            "fence markers are not rendered"
        );
    }
}
