//! Desktop-visible context injectors: the computer-use contract, the todo
//! reminder, user preferences, and pending tasks.
//!
//! These match `packages/agent-core/src/agent/injection`. A sub-agent does not
//! get the preference or pending briefings. The computer-use text is the same
//! contract the TypeScript injector reads from `computer-use.md`.

use lmcode_llm::{Message, MessageOrigin, Role};
use lmcode_memory::{MemoKind, MemoryMemo};

const COMPUTER_USE_GUIDANCE: &str = include_str!("computer-use.md");
const FULL_REFRESH_TURNS: usize = 5;
const SPARSE_REMINDER_TURNS: usize = 2;

const SPARSE_REMINDER: &str = "\
Computer use is still active (full operating contract given earlier).
Before acting on a window: re-read its state with get_window_state and use a handle from that
snapshot. Keep background delivery as the first attempt, verify the outcome from fresh state,
and remember that cancelled or delivered input is not rolled back.
Batch already-decided, independent actions in one reply (they run in order); never batch actions
that depend on a snapshot taken in the same batch.";

const EXIT_REMINDER: &str = "\
Computer use is no longer active. The desktop tools are gone and you can no longer observe or
operate the user's applications.
  - Do not claim to have seen the screen or acted on a window after this point.
  - Anything already delivered to the desktop stays delivered; ask the user to confirm state.";

const TODO_LIST_TOOL_NAME: &str = "TodoList";
const TODO_LIST_REMINDER_VARIANT: &str = "todo_list_reminder";
const TODO_LIST_REMINDER_TURNS: usize = 10;

/// History length above which a session is resumed, not fresh.
pub const FRESH_SESSION_MAX_HISTORY: usize = 2;
pub const USER_PREFERENCE_INJECTION_LIMIT: usize = 12;
pub const PENDING_TASK_INJECTION_LIMIT: usize = 3;
pub const PENDING_TASK_MAX_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;

const MAX_TASK_CHARS: usize = 100;
const MAX_PROGRESS_CHARS: usize = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Main,
    Sub,
}

/// Restates the desktop operating contract while computer use is on, withdraws
/// it once when the capability stops, and refreshes it after enough assistant turns.
#[derive(Debug, Default)]
pub struct ComputerUseInjector {
    was_active: bool,
    injected_at: Option<usize>,
}

impl ComputerUseInjector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop the remembered position so the next active turn restates the contract.
    pub fn on_context_compacted(&mut self) {
        self.injected_at = None;
    }

    pub fn inject(&mut self, active: bool, history: &mut Vec<Message>) {
        let Some(text) = self.prepare(active, history) else {
            return;
        };
        self.injected_at = Some(history.len());
        history.push(injection_message(text, "computer_use"));
    }

    fn prepare(&mut self, active: bool, history: &[Message]) -> Option<String> {
        if !active {
            if !self.was_active {
                return None;
            }
            self.was_active = false;
            self.injected_at = None;
            return Some(EXIT_REMINDER.to_string());
        }
        if !self.was_active {
            self.injected_at = None;
            self.was_active = true;
            return Some(COMPUTER_USE_GUIDANCE.to_string());
        }
        let Some(injected_at) = self.injected_at else {
            return Some(COMPUTER_USE_GUIDANCE.to_string());
        };
        let mut assistant_turns = 0usize;
        for message in history.iter().skip(injected_at + 1) {
            if message.role == Role::Assistant {
                assistant_turns += 1;
                continue;
            }
            if message.role == Role::User {
                return Some(COMPUTER_USE_GUIDANCE.to_string());
            }
        }
        if assistant_turns >= FULL_REFRESH_TURNS {
            return Some(COMPUTER_USE_GUIDANCE.to_string());
        }
        if assistant_turns >= SPARSE_REMINDER_TURNS {
            return Some(SPARSE_REMINDER.to_string());
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoView {
    pub title: String,
    pub status: String,
}

/// Reminder text when TodoList has gone untouched for ten assistant turns.
pub fn todo_list_reminder(
    history: &[Message],
    tool_active: bool,
    todos: &[TodoView],
) -> Option<String> {
    if !tool_active {
        return None;
    }
    let counts = reminder_turn_counts(history);
    if counts.turns_since_write < TODO_LIST_REMINDER_TURNS
        || counts.turns_since_reminder < TODO_LIST_REMINDER_TURNS
    {
        return None;
    }
    Some(render_todo_reminder(todos))
}

struct TurnCounts {
    turns_since_write: usize,
    turns_since_reminder: usize,
}

fn reminder_turn_counts(history: &[Message]) -> TurnCounts {
    let mut found_write = false;
    let mut found_reminder = false;
    let mut turns_since_write = 0usize;
    let mut turns_since_reminder = 0usize;
    for message in history.iter().rev() {
        if message.role == Role::Assistant {
            if !found_write && has_todo_write(message) {
                found_write = true;
            }
            if !found_write {
                turns_since_write += 1;
            }
            if !found_reminder {
                turns_since_reminder += 1;
            }
            continue;
        }
        if !found_reminder && is_todo_reminder(message) {
            found_reminder = true;
        }
        if found_write && found_reminder {
            break;
        }
    }
    TurnCounts {
        turns_since_write,
        turns_since_reminder,
    }
}

fn has_todo_write(message: &Message) -> bool {
    message.tool_calls.iter().any(|call| {
        if call.name != TODO_LIST_TOOL_NAME {
            return false;
        }
        let Some(arguments) = call.arguments.as_deref() else {
            return false;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(arguments) else {
            return false;
        };
        parsed
            .get("todos")
            .and_then(serde_json::Value::as_array)
            .is_some()
    })
}

fn is_todo_reminder(message: &Message) -> bool {
    matches!(
        &message.origin,
        Some(MessageOrigin::Injection { variant: Some(variant) }) if variant == TODO_LIST_REMINDER_VARIANT
    )
}

fn render_todo_reminder(todos: &[TodoView]) -> String {
    let mut message = "The TodoList tool has not been updated recently. If you are working on tasks that benefit from progress tracking, consider using TodoList to update task status. Also consider clearing or rewriting the todo list if it has become stale and no longer matches the current work. Only use it if relevant. This is a gentle reminder; ignore it if not applicable. Make sure that you NEVER mention this reminder to the user.".to_string();
    let items = render_todo_items(todos);
    if !items.is_empty() {
        message.push_str("\n\nCurrent todo list:\n");
        message.push_str(&items);
    }
    message
}

fn render_todo_items(todos: &[TodoView]) -> String {
    todos
        .iter()
        .filter(|todo| matches!(todo.status.as_str(), "pending" | "in_progress" | "done"))
        .enumerate()
        .map(|(index, todo)| format!("{}. [{}] {}", index + 1, todo.status, todo.title))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Bullet list of preference memos. Task memos are skipped. A blank rule falls
/// back to the scene (`user_need`).
pub fn render_user_preference_lines(memos: &[MemoryMemo]) -> String {
    let mut lines = Vec::new();
    for memo in memos {
        if memo.kind != MemoKind::Preference {
            continue;
        }
        let rule = {
            let approach = memo.approach.trim();
            if approach.is_empty() {
                memo.user_need.trim().to_string()
            } else {
                approach.to_string()
            }
        };
        if rule.is_empty() {
            continue;
        }
        let tags = if memo.tags.is_empty() {
            String::new()
        } else {
            format!("（{}）", memo.tags.join("、"))
        };
        lines.push(format!("- {rule}{tags}"));
    }
    lines.join("\n")
}

#[derive(Debug, Default)]
pub struct UserPreferencesInjector {
    last_injected: Option<String>,
    injected_at: Option<usize>,
}

impl UserPreferencesInjector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_context_compacted(&mut self, compacted_count: usize) {
        let Some(injected_at) = self.injected_at else {
            return;
        };
        let shifted = injected_at as isize - compacted_count as isize + 1;
        self.injected_at = if shifted >= 0 {
            Some(shifted as usize)
        } else {
            None
        };
    }

    pub fn collect(
        &mut self,
        kind: AgentKind,
        _history_len: usize,
        rendered: Result<String, ()>,
    ) -> Option<String> {
        if kind != AgentKind::Main {
            return None;
        }
        let rendered = rendered.ok()?;
        if rendered.is_empty() {
            return None;
        }
        // A compacted injection lands at index 0. That index is not proof the
        // briefing is still in the prefix, so the same list is published again.
        if self.last_injected.as_deref() == Some(rendered.as_str())
            && self.injected_at.is_some_and(|index| index > 0)
        {
            return None;
        }
        self.last_injected = Some(rendered.clone());
        Some(preference_text(&rendered))
    }

    pub fn inject(
        &mut self,
        kind: AgentKind,
        history: &mut Vec<Message>,
        rendered: Result<String, ()>,
    ) {
        let Some(text) = self.collect(kind, history.len(), rendered) else {
            return;
        };
        self.injected_at = Some(history.len());
        history.push(injection_message(text, "user_preferences"));
    }
}

fn preference_text(rendered: &str) -> String {
    format!(
        "该用户的长期偏好与习惯（来自历史会话的记忆）：\n\n{rendered}\n\n请默认遵循以上偏好；如果用户在当前会话中提出不同要求，以当前要求为准。\n当用户明确要求\"记住\"一条新偏好、或纠正一条旧偏好时，调用 MemoryWrite 工具并把 kind 设为 \"preference\" 更新记忆。"
    )
}

pub fn format_session_age(now_ms: i64, timestamp_ms: i64) -> String {
    let age = now_ms.saturating_sub(timestamp_ms);
    if age < 60_000 {
        return "刚刚".to_string();
    }
    let minutes = age / 60_000;
    if minutes < 60 {
        return format!("{minutes} 分钟前");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours} 小时前");
    }
    let days = hours / 24;
    if days < 7 {
        return format!("{days} 天前");
    }
    let Some(stamp) = chrono::DateTime::from_timestamp_millis(timestamp_ms) else {
        return "未知时间".to_string();
    };
    stamp
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string()
}

/// Bullet list of pending memos newer than two weeks, at most `limit` lines.
pub fn render_pending_task_lines(memos: &[MemoryMemo], now_ms: i64, limit: usize) -> String {
    let mut lines = Vec::new();
    for memo in memos {
        if lines.len() >= limit {
            break;
        }
        if memo.kind != MemoKind::Pending {
            continue;
        }
        if now_ms.saturating_sub(memo.recorded_at) > PENDING_TASK_MAX_AGE_MS {
            continue;
        }
        let task = truncate_tail(memo.user_need.trim(), MAX_TASK_CHARS);
        if task.is_empty() {
            continue;
        }
        let progress = truncate_tail(&collapse_whitespace(&memo.approach), MAX_PROGRESS_CHARS);
        let detail = if progress.is_empty() {
            String::new()
        } else {
            format!(" · 进度：{progress}")
        };
        let age = format_session_age(now_ms, memo.recorded_at);
        lines.push(format!("- {task}{detail}（{age}）"));
    }
    lines.join("\n")
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_tail(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars).collect();
    format!("{kept}…")
}

#[derive(Debug, Default)]
pub struct PendingTasksInjector {
    has_published: bool,
}

impl PendingTasksInjector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_published(&self) -> bool {
        self.has_published
    }

    /// `render` is called only for a fresh main session that has not been briefed.
    pub fn collect(
        &mut self,
        kind: AgentKind,
        history_len: usize,
        render: impl FnOnce() -> Result<String, ()>,
    ) -> Option<String> {
        if self.has_published || kind != AgentKind::Main || history_len > FRESH_SESSION_MAX_HISTORY
        {
            return None;
        }
        let rendered = render().ok()?;
        if rendered.is_empty() {
            return None;
        }
        self.has_published = true;
        Some(format!(
            "用户有未完成的工作（来自此前会话的记忆）：\n\n{rendered}\n\n如果用户提到\"继续\"或相关任务，可以直接从这里接着做。某项完成（或用户确认不再需要）后记得销账：先用 MemoryLookup 找到该条记录，再用 MemoryEdit 删除或更新它；与当前话题无关时忽略即可。"
        ))
    }
}

fn injection_message(text: impl Into<String>, variant: &str) -> Message {
    Message::user(text).with_origin(MessageOrigin::Injection {
        variant: Some(variant.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lmcode_llm::{ContentPart, ToolCall};

    fn preference_memo(approach: &str, kind: MemoKind, tags: Vec<String>) -> MemoryMemo {
        let mut memo = MemoryMemo::new("所有会话", approach, "已记录", "session-1", "", kind, tags);
        memo.recorded_at = 1;
        memo
    }

    fn assistant_text(text: &str) -> Message {
        Message::assistant(
            vec![ContentPart::Text {
                text: text.to_string(),
            }],
            Vec::new(),
        )
    }

    fn assistant_todo_write(arguments: &str) -> Message {
        Message::assistant(
            Vec::new(),
            vec![ToolCall::new(
                "todo-1",
                TODO_LIST_TOOL_NAME,
                Some(arguments.to_string()),
            )],
        )
    }

    fn pending_memo(
        user_need: &str,
        approach: &str,
        kind: MemoKind,
        recorded_at: i64,
    ) -> MemoryMemo {
        let mut memo = MemoryMemo::new(
            user_need,
            approach,
            "未完成",
            "session-1",
            "",
            kind,
            Vec::new(),
        );
        memo.recorded_at = recorded_at;
        memo
    }

    fn text_of(history: &[Message], index: usize) -> String {
        history.get(index).map(Message::text).unwrap_or_default()
    }

    #[test]
    fn computer_use_contract_follows_activation_silence_exit_and_refresh() {
        let mut history = Vec::new();
        let mut injector = ComputerUseInjector::new();
        injector.inject(true, &mut history);
        let full = text_of(&history, 0);
        assert!(full.contains("get_window_state"), "{full}");
        assert!(full.contains("element_token"));
        assert!(full.contains("background"));
        assert!(full.contains("verify_state"));
        assert!(full.contains("not withdrawn"));
        assert!(full.contains("costing one round trip instead of many"));

        let after_first = history.len();
        injector.inject(true, &mut history);
        assert_eq!(history.len(), after_first);

        injector.inject(false, &mut history);
        let exit = text_of(&history, 1);
        assert!(exit.contains("no longer active"), "{exit}");
        assert!(exit.contains("stays delivered"));
        let after_exit = history.len();
        injector.inject(false, &mut history);
        assert_eq!(history.len(), after_exit);

        let mut live = ComputerUseInjector::new();
        let mut again = Vec::new();
        live.inject(true, &mut again);
        let after = again.len();
        for _ in 0..5 {
            again.push(assistant_text("ok"));
        }
        live.inject(true, &mut again);
        assert_eq!(again.len(), after + 6);
        assert!(text_of(&again, after + 5).contains("get_window_state"));

        let mut sparse = ComputerUseInjector::new();
        let mut brief = Vec::new();
        sparse.inject(true, &mut brief);
        let after = brief.len();
        brief.push(assistant_text("ok"));
        brief.push(assistant_text("ok"));
        sparse.inject(true, &mut brief);
        assert_eq!(brief.len(), after + 3);
        let reminder = text_of(&brief, after + 2);
        assert!(reminder.contains("still active"), "{reminder}");
        assert!(reminder.contains("Batch already-decided"));

        let mut quiet = ComputerUseInjector::new();
        let mut empty = Vec::new();
        quiet.inject(false, &mut empty);
        assert!(empty.is_empty());
    }

    #[test]
    fn todo_reminder_waits_ten_turns_and_prints_the_current_list() {
        let todos = vec![TodoView {
            title: "Write the port".to_string(),
            status: "in_progress".to_string(),
        }];
        let mut history = Vec::new();
        for _ in 0..9 {
            history.push(assistant_text("working"));
        }
        assert!(todo_list_reminder(&history, true, &todos).is_none());
        history.push(assistant_text("working"));
        let reminder = todo_list_reminder(&history, true, &todos).expect("reminder");
        assert!(reminder.contains("NEVER mention this reminder"));
        assert!(reminder.contains("1. [in_progress] Write the port"));
        assert!(todo_list_reminder(&history, false, &todos).is_none());

        history.push(assistant_todo_write(
            r#"{"todos":[{"title":"Write the port","status":"done"}]}"#,
        ));
        assert!(todo_list_reminder(&history, true, &todos).is_none());

        let mut after_write = vec![assistant_todo_write(r#"{"todos":[]}"#)];
        for _ in 0..10 {
            after_write.push(assistant_text("still going"));
        }
        assert!(todo_list_reminder(&after_write, true, &[]).is_some());

        after_write.push(injection_message("nudge", TODO_LIST_REMINDER_VARIANT));
        assert!(todo_list_reminder(&after_write, true, &[]).is_none());
    }

    #[test]
    fn preference_lines_skip_task_memos_and_fall_back_to_the_scene() {
        let lines = render_user_preference_lines(&[
            preference_memo(
                "回复用中文",
                MemoKind::Preference,
                vec!["偏好".into(), "沟通".into()],
            ),
            preference_memo("修复构建", MemoKind::Task, Vec::new()),
        ]);
        assert_eq!(lines, "- 回复用中文（偏好、沟通）");
        let fallback = render_user_preference_lines(&[preference_memo(
            "   ",
            MemoKind::Preference,
            Vec::new(),
        )]);
        assert_eq!(fallback, "- 所有会话");
    }

    #[test]
    fn preference_injector_publishes_once_until_the_list_or_compaction_changes() {
        let mut history = vec![Message::user("hello"), Message::user("hi")];
        let mut injector = UserPreferencesInjector::new();
        let first = injector
            .collect(
                AgentKind::Main,
                history.len(),
                Ok("- 回复用中文".to_string()),
            )
            .expect("first");
        assert!(first.contains("- 回复用中文"));
        assert!(first.contains("MemoryWrite"));

        injector.inject(
            AgentKind::Main,
            &mut history,
            Ok("- 回复用中文".to_string()),
        );
        assert!(
            injector
                .collect(
                    AgentKind::Main,
                    history.len(),
                    Ok("- 回复用中文".to_string())
                )
                .is_none()
        );

        let changed = injector
            .collect(
                AgentKind::Main,
                history.len(),
                Ok("- 回复用中文\n- 常用 pnpm".to_string()),
            )
            .expect("changed");
        assert!(changed.contains("- 常用 pnpm"));

        injector.inject(
            AgentKind::Main,
            &mut history,
            Ok("- 回复用中文".to_string()),
        );
        assert!(
            injector
                .collect(
                    AgentKind::Main,
                    history.len(),
                    Ok("- 回复用中文".to_string())
                )
                .is_none()
        );
        injector.on_context_compacted(history.len());
        let republished = injector
            .collect(
                AgentKind::Main,
                history.len(),
                Ok("- 回复用中文".to_string()),
            )
            .expect("after compaction");
        assert!(republished.contains("- 回复用中文"));

        assert!(
            injector
                .collect(AgentKind::Main, 1, Ok(String::new()))
                .is_none()
        );
        assert!(
            injector
                .collect(AgentKind::Sub, 1, Ok("- 回复用中文".to_string()))
                .is_none()
        );
    }

    #[test]
    fn pending_lines_keep_recent_pending_memos_and_drop_the_rest() {
        let now = 1_780_000_000_000i64;
        let lines = render_pending_task_lines(
            &[pending_memo(
                "修复 flaky test",
                "已定位到 Windows 文件锁，下一步验证重试预算",
                MemoKind::Pending,
                now - 2 * 86_400_000,
            )],
            now,
            PENDING_TASK_INJECTION_LIMIT,
        );
        assert_eq!(
            lines,
            "- 修复 flaky test · 进度：已定位到 Windows 文件锁，下一步验证重试预算（2 天前）"
        );

        let mixed = render_pending_task_lines(
            &[
                pending_memo("完成的任务", "升级依赖", MemoKind::Task, now),
                pending_memo("回复用中文", "中文", MemoKind::Preference, now),
                pending_memo("过期任务", "旧", MemoKind::Pending, now - 15 * 86_400_000),
                pending_memo("   ", "空白", MemoKind::Pending, now),
                pending_memo(
                    "进行中的任务",
                    "已定位到 Windows 文件锁",
                    MemoKind::Pending,
                    now - 60_000,
                ),
            ],
            now,
            PENDING_TASK_INJECTION_LIMIT,
        );
        assert_eq!(
            mixed,
            "- 进行中的任务 · 进度：已定位到 Windows 文件锁（1 分钟前）"
        );

        let limited = render_pending_task_lines(
            &[
                pending_memo("任务 A", "a", MemoKind::Pending, now),
                pending_memo("任务 B", "b", MemoKind::Pending, now),
                pending_memo("任务 C", "c", MemoKind::Pending, now),
            ],
            now,
            2,
        );
        assert!(limited.contains("任务 A"));
        assert!(limited.contains("任务 B"));
        assert!(!limited.contains("任务 C"));

        let blank = render_pending_task_lines(
            &[pending_memo("任务", "   ", MemoKind::Pending, now)],
            now,
            3,
        );
        assert_eq!(blank, "- 任务（刚刚）");
        let wrapped = render_pending_task_lines(
            &[pending_memo(
                "任务",
                "first\n\nsecond   line",
                MemoKind::Pending,
                now,
            )],
            now,
            3,
        );
        assert_eq!(wrapped, "- 任务 · 进度：first second line（刚刚）");
    }

    #[test]
    fn pending_injector_briefs_a_fresh_main_session_once() {
        let mut injector = PendingTasksInjector::new();
        let first = injector
            .collect(AgentKind::Main, 1, || {
                Ok("- 修复 flaky test（2 天前）".to_string())
            })
            .expect("brief");
        assert!(first.contains("修复 flaky test"));
        assert!(first.contains("MemoryEdit"));
        assert!(first.contains("销账"));
        assert!(
            injector
                .collect(AgentKind::Main, 1, || Ok(
                    "- 修复 flaky test（2 天前）".to_string()
                ))
                .is_none()
        );

        let mut called = false;
        let mut quiet = PendingTasksInjector::new();
        assert!(
            quiet
                .collect(AgentKind::Main, 3, || {
                    called = true;
                    Ok("- x".to_string())
                })
                .is_none()
        );
        assert!(!called);

        let mut child = PendingTasksInjector::new();
        assert!(
            child
                .collect(AgentKind::Sub, 1, || Ok("- x".to_string()))
                .is_none()
        );

        let mut broken = PendingTasksInjector::new();
        assert!(broken.collect(AgentKind::Main, 1, || Err(())).is_none());
    }

    #[test]
    fn preference_and_pending_renderers_read_the_memo_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = lmcode_memory::MemoStore::open(&dir.path().join("memos.sqlite")).unwrap();
        let mut preference = preference_memo(
            "回复用中文",
            MemoKind::Preference,
            vec!["偏好".into(), "沟通".into()],
        );
        preference.user_need = "所有会话".to_string();
        let task = preference_memo("升级依赖", MemoKind::Task, Vec::new());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut pending = pending_memo(
            "修复 flaky test",
            "已定位到文件锁，下一步验证重试预算",
            MemoKind::Pending,
            now,
        );
        pending.user_need = "修复 flaky test".to_string();
        store.append(&preference).unwrap();
        store.append(&task).unwrap();
        store.append(&pending).unwrap();

        let memos = store.all().unwrap();
        let preferences = render_user_preference_lines(&memos);
        assert_eq!(preferences, "- 回复用中文（偏好、沟通）");
        assert!(!preferences.contains("升级依赖"));

        let pending_lines = render_pending_task_lines(&memos, now, 3);
        assert!(pending_lines.contains("修复 flaky test"), "{pending_lines}");
        assert!(
            pending_lines.contains("进度：已定位到文件锁"),
            "{pending_lines}"
        );
        assert!(!pending_lines.contains("升级依赖"));
        assert!(!pending_lines.contains("回复用中文"));
    }
}
