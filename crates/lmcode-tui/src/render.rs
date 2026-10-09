//! Rendering for the TUI: transcript, input line, status bar, approval modal.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Position, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph, Wrap},
};
use unicode_width::UnicodeWidthChar;

use crate::app::{App, PendingApproval, Status, TranscriptEntry};

/// Draw one frame.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let [transcript_area, input_area, status_area] = Layout::vertical([
        Constraint::Min(3),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(area);

    render_transcript(frame, app, transcript_area);
    render_input(frame, app, input_area);
    render_status(frame, app, status_area);

    if let Some(picker) = &app.picker {
        render_picker(frame, picker, area);
    }
    render_mention(frame, app, input_area);
    if app.mcp_panel {
        render_mcp_panel(frame, app, area);
    }
    if let Some(approval) = &app.pending_approval {
        render_approval(frame, approval, area);
    }
}

fn render_transcript(frame: &mut Frame, app: &App, area: Rect) {
    let lines = transcript_lines(app, area.width as usize);
    let viewport = area.height as usize;
    let total = lines.len();
    let max_scroll = total.saturating_sub(viewport);
    let offset = max_scroll.saturating_sub(app.scroll as usize);
    let paragraph = Paragraph::new(lines).scroll(((offset.min(u16::MAX as usize)) as u16, 0));
    frame.render_widget(paragraph, area);
}

/// Flatten the transcript into renderable lines for the given width.
pub fn transcript_lines(app: &App, width: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    for entry in &app.transcript {
        match entry {
            TranscriptEntry::User(text) => {
                for (index, line) in wrap_text(text, width.saturating_sub(2))
                    .into_iter()
                    .enumerate()
                {
                    let prefix = if index == 0 { "❯ " } else { "  " };
                    lines.push(Line::from(vec![
                        Span::styled(prefix, Style::default().fg(Color::Cyan)),
                        Span::raw(line),
                    ]));
                }
            }
            TranscriptEntry::Assistant { text, thinking } => {
                if !thinking.is_empty() {
                    for line in wrap_text(thinking, width.saturating_sub(4)) {
                        lines.push(Line::from(Span::styled(
                            format!("  💭 {line}"),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                }
                for line in crate::markdown::render_markdown(text, width) {
                    lines.push(line);
                }
            }
            TranscriptEntry::Tool {
                name,
                arguments,
                result,
            } => {
                let budget = width.saturating_sub(name.chars().count() + 6).max(8);
                let args = truncate_chars(arguments, budget);
                lines.push(Line::from(vec![
                    Span::styled("  ⚙ ", Style::default().fg(Color::Yellow)),
                    Span::styled(
                        name.clone(),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!(" {args}"), Style::default().fg(Color::DarkGray)),
                ]));
                if let Some(result) = result {
                    let (mark, color) = if result.ok {
                        ("✓", Color::Green)
                    } else {
                        ("✗", Color::Red)
                    };
                    lines.push(Line::from(Span::styled(
                        format!("    {mark} {name}"),
                        Style::default().fg(color),
                    )));
                    lines.extend(crate::diff::render_tool_result(&result.text, width));
                }
            }
            TranscriptEntry::Notice(text) => {
                for line in wrap_text(text, width.saturating_sub(2)) {
                    lines.push(Line::from(Span::styled(
                        format!("  {line}"),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
            }
            TranscriptEntry::Error(text) => {
                for line in wrap_text(text, width.saturating_sub(2)) {
                    lines.push(Line::from(Span::styled(
                        format!("  error: {line}"),
                        Style::default().fg(Color::Red),
                    )));
                }
            }
        }
    }
    lines
}

fn render_input(frame: &mut Frame, app: &App, area: Rect) {
    let border_style = if app.status == Status::Generating {
        Style::default().fg(Color::DarkGray)
    } else {
        Style::default().fg(Color::Cyan)
    };
    let block = Block::bordered()
        .border_style(border_style)
        .title(Span::styled(
            " input ",
            Style::default().fg(Color::DarkGray),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let text = app.input.buffer();
    frame.render_widget(Paragraph::new(text), inner);

    // Cursor position: display width of the text before the cursor.
    let before_cursor: String = text.chars().take(app.input.cursor()).collect();
    let cursor_width: u16 = before_cursor
        .chars()
        .map(|character| UnicodeWidthChar::width(character).unwrap_or(1).max(1) as u16)
        .sum();
    let cursor_x = (inner.x + cursor_width).min(inner.x + inner.width.saturating_sub(1));
    frame.set_cursor_position(Position::new(cursor_x, inner.y));
}

/// Draw the `@file` mention popup just above the input box.
fn render_mention(frame: &mut Frame, app: &App, input_area: Rect) {
    let Some(state) = &app.mention else {
        return;
    };
    const MAX_VISIBLE: usize = 8;
    let count = state.candidates.len().min(MAX_VISIBLE) as u16;
    let height = count + 2; // borders
    if input_area.y < height + 1 {
        return;
    }
    let width = (input_area.width.saturating_sub(2)).clamp(20, 60);
    let area = Rect::new(input_area.x, input_area.y - height, width, height);
    frame.render_widget(Clear, area);
    let start = state.selected.saturating_sub(MAX_VISIBLE - 1);
    let mut lines: Vec<Line> = Vec::new();
    for (index, candidate) in state
        .candidates
        .iter()
        .enumerate()
        .skip(start)
        .take(MAX_VISIBLE)
    {
        let selected = index == state.selected;
        let marker = if selected { "❯ " } else { "  " };
        let style = if selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(marker, Style::default().fg(Color::Cyan)),
            Span::styled(truncate_chars(candidate, width as usize - 4), style),
        ]));
    }
    let block = Block::bordered().title(" @files ");
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// Draw the read-only `/mcp` panel listing connected servers and their tools.
fn render_mcp_panel(frame: &mut Frame, app: &App, area: Rect) {
    let rows = app.mcp_rows();
    let mut lines: Vec<Line> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.mcp_selected;
        let pointer = if selected { "❯ " } else { "  " };
        match row {
            crate::app::McpRow::Server(server_index) => {
                let Some(server) = app.mcp_servers.get(*server_index) else {
                    continue;
                };
                let (marker, color) = match server.status.as_str() {
                    "connected" => ("●", Color::Green),
                    "failed" => ("✗", Color::Red),
                    _ => ("⏸", Color::Yellow),
                };
                let name_style = if selected {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Cyan)
                };
                lines.push(Line::from(vec![
                    Span::styled(pointer, Style::default().fg(Color::Cyan)),
                    Span::styled(format!("{marker} "), Style::default().fg(color)),
                    Span::styled(server.name.clone(), name_style),
                    Span::styled(
                        format!(" · {} tool(s)", server.tools.len()),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]));
                if app.mcp_confirm.as_deref() == Some(server.name.as_str()) {
                    lines.push(Line::from(Span::styled(
                        "    press d again to uninstall",
                        Style::default().fg(Color::Yellow),
                    )));
                }
                if let Some(error) = &server.error {
                    lines.push(Line::from(Span::styled(
                        format!("    {error}"),
                        Style::default().fg(Color::Red),
                    )));
                }
                for tool in &server.tools {
                    lines.push(Line::from(Span::styled(
                        format!("    {tool}"),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
            }
            crate::app::McpRow::Recommended(recommendation_index) => {
                let Some(recommendation) =
                    crate::app::MCP_RECOMMENDATIONS.get(*recommendation_index)
                else {
                    continue;
                };
                let name_style = if selected {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::DarkGray)
                };
                lines.push(Line::from(vec![
                    Span::styled(pointer, Style::default().fg(Color::Cyan)),
                    Span::styled("+ ", Style::default().fg(Color::DarkGray)),
                    Span::styled(recommendation.display_name.to_string(), name_style),
                    Span::styled(
                        format!(" · {} (not installed)", recommendation.description),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]));
            }
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "no MCP servers configured",
            Style::default().fg(Color::DarkGray),
        )));
    }
    let height = (lines.len() as u16 + 2).min(area.height.saturating_sub(2));
    let popup = centered_rect(70, height, area);
    frame.render_widget(Clear, popup);
    let block = Block::bordered().title(" MCP · Enter toggle/install · d uninstall · Esc close ");
    frame.render_widget(Paragraph::new(lines).block(block), popup);
}

fn render_status(frame: &mut Frame, app: &App, area: Rect) {
    let status = match app.status {
        Status::Idle => "idle",
        Status::Generating => "generating…",
        Status::Interrupted => "interrupted",
    };
    let mut text = format!(" lmcode · {} · {status}", app.model);
    if let Some(session) = &app.session_id {
        let short: String = session
            .chars()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        text.push_str(&format!(" · {short}"));
    }
    let style = match app.status {
        Status::Idle => Style::default().fg(Color::DarkGray),
        Status::Generating => Style::default().fg(Color::Cyan),
        Status::Interrupted => Style::default().fg(Color::Yellow),
    };
    let line = truncate_chars(&text, area.width as usize);
    frame.render_widget(Paragraph::new(line).style(style), area);
}

fn render_approval(frame: &mut Frame, approval: &PendingApproval, area: Rect) {
    let popup = centered_rect(64, 8, area);
    frame.render_widget(Clear, popup);
    let arguments = truncate_chars(
        &approval.arguments,
        (popup.width as usize).saturating_sub(4),
    );
    let lines = vec![
        Line::from(Span::styled(
            approval.name.clone(),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(arguments),
        Line::from(""),
        Line::from(vec![
            Span::styled("[y]", Style::default().fg(Color::Green)),
            Span::raw(" approve   "),
            Span::styled("[n]", Style::default().fg(Color::Red)),
            Span::raw(" deny"),
        ]),
    ];
    let paragraph = Paragraph::new(lines)
        .block(Block::bordered().title(" tool approval "))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, popup);
}

fn render_picker(frame: &mut Frame, picker: &crate::picker::Picker, area: Rect) {
    let popup = centered_rect(70, 60, area);
    frame.render_widget(Clear, popup);
    let (start, count) = picker.window(popup.height.saturating_sub(2) as usize);
    let mut lines: Vec<Line> = Vec::new();
    for (offset, item) in picker.items[start..start + count].iter().enumerate() {
        let selected = start + offset == picker.selected;
        let marker = if selected { "❯ " } else { "  " };
        let label_style = if selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(marker, Style::default().fg(Color::Cyan)),
            Span::styled(item.label.clone(), label_style),
            Span::styled(
                format!("  {}", item.detail),
                Style::default().fg(Color::DarkGray),
            ),
        ]));
    }
    let title = format!(" {} (↑/↓ · Enter · Esc) ", picker.title);
    let paragraph = Paragraph::new(lines).block(Block::bordered().title(title));
    frame.render_widget(paragraph, popup);
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let width = (area.width * percent_x / 100).min(area.width);
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect::new(x, y, width, height.min(area.height))
}

/// Wrap text to `width` display columns, preserving explicit newlines.
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut result = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            result.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut current_width = 0usize;
        for character in raw_line.chars() {
            let char_width = UnicodeWidthChar::width(character).unwrap_or(1).max(1);
            if current_width + char_width > width && !current.is_empty() {
                result.push(std::mem::take(&mut current));
                current_width = 0;
            }
            current.push(character);
            current_width += char_width;
        }
        result.push(current);
    }
    result
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_ascii_and_cjk_by_display_width() {
        assert_eq!(wrap_text("abcdef", 3), vec!["abc", "def"]);
        // CJK characters occupy two columns each.
        assert_eq!(wrap_text("你好世界", 4), vec!["你好", "世界"]);
        assert_eq!(wrap_text("ab你cd", 4), vec!["ab你", "cd"]);
    }

    #[test]
    fn wrap_preserves_explicit_newlines() {
        assert_eq!(wrap_text("a\n\nb", 10), vec!["a", "", "b"]);
    }

    #[test]
    fn wrap_never_loops_on_oversized_characters() {
        assert_eq!(wrap_text("你", 1), vec!["你"]);
    }

    #[test]
    fn truncation_marks_elision() {
        assert_eq!(truncate_chars("abcdef", 4), "abc…");
        assert_eq!(truncate_chars("abc", 4), "abc");
    }
}
