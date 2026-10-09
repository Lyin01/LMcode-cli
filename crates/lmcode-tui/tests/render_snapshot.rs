//! Render smoke tests using ratatui's `TestBackend`: the drawn buffer must
//! contain the transcript text, the status line, and the approval modal.

use lmcode_tui::app::{App, McpServerInfo, PendingApproval};
use lmcode_tui::bridge::AgentEvent;
use lmcode_tui::render;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use tokio::sync::oneshot;

/// Draw one frame into an in-memory terminal and flatten the buffer to text.
fn draw(app: &App, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render::render(frame, app)).unwrap();
    let buffer = terminal.backend().buffer();
    let mut output = String::new();
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            output.push_str(buffer[(x, y)].symbol());
        }
        output.push('\n');
    }
    output
}

#[test]
fn renders_transcript_status_and_input() {
    let mut app = App::new(
        "opencode-go/test-model".to_string(),
        Some("session_abcd1234".to_string()),
    );
    app.push_user_message("hello there".to_string());
    app.apply_agent_event(AgentEvent::ThinkDelta("thinking…".to_string()));
    app.apply_agent_event(AgentEvent::TextDelta("Hi!".to_string()));
    app.input.insert('d');
    app.input.insert('r');

    let screen = draw(&app, 80, 20);
    assert!(screen.contains("hello there"), "screen:\n{screen}");
    assert!(screen.contains("Hi!"), "screen:\n{screen}");
    assert!(
        screen.contains("opencode-go/test-model"),
        "screen:\n{screen}"
    );
    assert!(screen.contains("input"), "screen:\n{screen}");
    assert!(screen.contains("idle"), "screen:\n{screen}");
    assert!(screen.contains("abcd1234"), "screen:\n{screen}");
}

#[test]
fn renders_tool_activity_with_result() {
    let mut app = App::new("m".to_string(), None);
    app.apply_agent_event(AgentEvent::ToolStart {
        name: "Bash".to_string(),
        arguments: "{\"command\":\"echo hi\"}".to_string(),
    });
    app.apply_agent_event(AgentEvent::ToolEnd {
        name: "Bash".to_string(),
        ok: true,
        result: "hi".to_string(),
    });
    let screen = draw(&app, 80, 20);
    assert!(screen.contains("Bash"), "screen:\n{screen}");
    assert!(screen.contains("echo hi"), "screen:\n{screen}");
    assert!(screen.contains('✓'), "screen:\n{screen}");
    assert!(screen.contains("    hi"), "result preview:\n{screen}");
}

#[test]
fn renders_edit_diff_result_with_signs() {
    let mut app = App::new("m".to_string(), None);
    app.apply_agent_event(AgentEvent::ToolStart {
        name: "Edit".to_string(),
        arguments: "{\"path\":\"src/lib.rs\"}".to_string(),
    });
    app.apply_agent_event(AgentEvent::ToolEnd {
        name: "Edit".to_string(),
        ok: true,
        result: "@@ -1,2 +1,2 @@\n-old line\n+new line".to_string(),
    });
    let screen = draw(&app, 80, 20);
    assert!(screen.contains("@@ -1,2 +1,2 @@"), "screen:\n{screen}");
    assert!(screen.contains("-old line"), "screen:\n{screen}");
    assert!(screen.contains("+new line"), "screen:\n{screen}");
}

#[test]
fn renders_approval_modal_over_the_transcript() {
    let mut app = App::new("m".to_string(), None);
    let (respond, _response) = oneshot::channel();
    app.pending_approval = Some(PendingApproval {
        name: "Bash".to_string(),
        arguments: "rm -rf build".to_string(),
        respond,
    });
    let screen = draw(&app, 80, 24);
    assert!(screen.contains("tool approval"), "screen:\n{screen}");
    assert!(screen.contains("Bash"), "screen:\n{screen}");
    assert!(screen.contains("rm -rf build"), "screen:\n{screen}");
    assert!(screen.contains("[y]"), "screen:\n{screen}");
    assert!(screen.contains("[n]"), "screen:\n{screen}");
}

#[test]
fn scrolls_long_transcripts_from_the_bottom() {
    let mut app = App::new("m".to_string(), None);
    for index in 0..60 {
        app.push_user_message(format!("message-{index}"));
    }

    // Pinned to the bottom: the newest message is visible, the oldest is not.
    let bottom = draw(&app, 60, 12);
    assert!(bottom.contains("message-59"), "screen:\n{bottom}");
    assert!(!bottom.contains("message-0\n"), "screen:\n{bottom}");

    // Scrolled to the top: the oldest message appears.
    app.scroll = u16::MAX;
    let top = draw(&app, 60, 12);
    assert!(top.contains("message-0"), "screen:\n{top}");
}

#[test]
fn renders_picker_popup_with_selection_marker() {
    use lmcode_tui::picker::{Picker, PickerItem, PickerKind};

    let mut app = App::new("m".to_string(), None);
    app.picker = Some(Picker::new(
        PickerKind::Model,
        "select model",
        vec![
            PickerItem {
                id: "provider-a/model-a".to_string(),
                label: "Model A".to_string(),
                detail: "provider-a/model-a".to_string(),
            },
            PickerItem {
                id: "provider-b/model-b".to_string(),
                label: "Model B".to_string(),
                detail: "provider-b/model-b".to_string(),
            },
        ],
    ));
    let screen = draw(&app, 80, 24);
    assert!(screen.contains("select model"), "screen:\n{screen}");
    assert!(screen.contains("Model A"), "screen:\n{screen}");
    assert!(screen.contains("Model B"), "screen:\n{screen}");
    assert!(screen.contains('❯'), "selection marker missing:\n{screen}");
}

#[test]
fn renders_markdown_in_assistant_messages() {
    let mut app = App::new("m".to_string(), None);
    app.apply_agent_event(AgentEvent::TextDelta(
        "# Title\n\nSome **bold** and `code`.\n\n- item one\n- item two\n\n```\nlet x = 1;\n```"
            .to_string(),
    ));
    let screen = draw(&app, 80, 30);
    assert!(screen.contains("Title"), "screen:\n{screen}");
    assert!(screen.contains("bold"), "screen:\n{screen}");
    assert!(screen.contains("code"), "screen:\n{screen}");
    assert!(screen.contains("item one"), "screen:\n{screen}");
    assert!(screen.contains("let x = 1;"), "screen:\n{screen}");
    assert!(
        !screen.contains("```"),
        "fence markers must not render:\n{screen}"
    );
}

#[test]
fn renders_mention_popup_with_candidates() {
    let root = std::env::temp_dir().join(format!("lmcode-mention-snap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/main.rs"), "").unwrap();
    let mut app = App::new("m".to_string(), None);
    app.cwd = root.clone();
    for ch in "open @src/ma".chars() {
        app.input.insert(ch);
    }
    app.refresh_mentions();
    let screen = draw(&app, 80, 24);
    assert!(screen.contains("@files"), "screen:\n{screen}");
    assert!(screen.contains("src/main.rs"), "screen:\n{screen}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn renders_mcp_panel_with_servers() {
    let mut app = App::new("m".to_string(), None);
    app.mcp_servers = vec![
        McpServerInfo {
            name: "blender".to_string(),
            status: "connected".to_string(),
            tools: vec!["mcp__blender__render".to_string()],
            error: None,
        },
        McpServerInfo {
            name: "github".to_string(),
            status: "failed".to_string(),
            tools: Vec::new(),
            error: Some("spawn failed".to_string()),
        },
    ];
    app.mcp_panel = true;
    let screen = draw(&app, 80, 24);
    assert!(screen.contains("MCP ·"), "screen:\n{screen}");
    assert!(screen.contains("blender"), "screen:\n{screen}");
    assert!(screen.contains("render"), "screen:\n{screen}");
    assert!(screen.contains("spawn failed"), "screen:\n{screen}");
    // Recommendations appear for servers that are not installed.
    assert!(screen.contains("Chrome DevTools"), "screen:\n{screen}");
}
