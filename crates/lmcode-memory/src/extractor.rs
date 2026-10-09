//! Compaction and exit-time memo extraction.
//!
//! Port of `packages/memory/src/extractor.ts`. Parses `memory-memo` and
//! `memory-resolve` fences out of model text, and builds the prompt the
//! exit-time extractor sends. Callers still fill `source_session_id`.

use serde_json::Value;

use crate::memo::{MemoKind, MemoryMemo};
use crate::tags::normalize_tags;

/// System prompt for exit-time extraction. The model must emit fences only.
pub const EXIT_EXTRACTION_SYSTEM_PROMPT: &str = "你是一个长期记忆提取助手。任务是：1）从对话记录中识别已完成的任务闭环，提炼任务经验记录；2）识别用户明确表达的、稳定的偏好与习惯，提炼偏好记录；3）识别明确未完成、需要下次继续的工作，提炼未完成事项记录；4）提示词给出待续清单时，把本次明确完成的待续事项输出为销账块。用对话的主要语言输出（中文对话用中文，英文对话用英文）。只输出指定的 JSON 格式，不要调用任何工具。";

const MAX_PENDING_TASK_CHARS: usize = 120;

/// A pending memo reduced to what the extraction model needs to close it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTaskRef {
    pub id: String,
    pub user_need: String,
}

/// Parse `memory-memo` blocks from compaction or exit output.
///
/// A malformed block is skipped. `{"none": true}` is skipped. `userNeed` must
/// be a non-empty string. Missing `whatFailed` / `whatWorked` become `"none"`.
/// Tags are kept only when the field is an array; otherwise the memo has no tags.
/// `extraction_source` is `compaction`. `source_session_id` is empty.
pub fn parse_memory_memos(text: &str) -> Vec<MemoryMemo> {
    let mut memos = Vec::new();
    for body in fenced_bodies(text, "memory-memo") {
        let Ok(parsed) = serde_json::from_str::<Value>(body.trim()) else {
            continue;
        };
        if parsed.get("none").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(user_need) = string_field(&parsed, "userNeed") else {
            continue;
        };
        if user_need.is_empty() {
            continue;
        }

        let tags = match parsed.get("tags") {
            Some(Value::Array(items)) => {
                let raw = items.iter().filter_map(Value::as_str).map(str::to_string);
                normalize_tags(raw, 5)
            }
            _ => Vec::new(),
        };
        let kind = parsed
            .get("kind")
            .and_then(Value::as_str)
            .map(MemoKind::parse)
            .unwrap_or(MemoKind::Task);

        let mut memo = MemoryMemo::new(
            user_need,
            string_field(&parsed, "approach").unwrap_or_default(),
            string_field(&parsed, "outcome").unwrap_or_default(),
            "",
            "",
            kind,
            tags,
        );
        memo.what_failed =
            string_field(&parsed, "whatFailed").unwrap_or_else(|| "none".to_string());
        memo.what_worked =
            string_field(&parsed, "whatWorked").unwrap_or_else(|| "none".to_string());
        memo.extraction_source = "compaction".to_string();
        memos.push(memo);
    }
    memos
}

/// Ids of pending memos the model reported as completed.
///
/// Ids stay inside `memory-resolve` fences so they cannot mix with memo
/// parsing. Malformed blocks are skipped. Ids are trimmed, blanks dropped,
/// and deduplicated in first-seen order.
pub fn parse_resolved_pending_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for body in fenced_bodies(text, "memory-resolve") {
        let Ok(parsed) = serde_json::from_str::<Value>(body.trim()) else {
            continue;
        };
        let Some(entries) = parsed.get("resolved").and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let Some(id) = entry.as_str().map(str::trim) else {
                continue;
            };
            if id.is_empty() || ids.iter().any(|seen| seen == id) {
                continue;
            }
            ids.push(id.to_string());
        }
    }
    ids
}

/// User prompt for exit-time extraction.
///
/// `pending_tasks == None` and an empty slice both omit the resolve section.
pub fn build_exit_extraction_prompt(
    session_id: &str,
    message_count: usize,
    sample_text: &str,
    pending_tasks: Option<&[PendingTaskRef]>,
) -> String {
    const HEAD: &str = r#"以下是会话 "__SESSION__"（共 __COUNT__ 条消息）的对话记录。请提取三类长期记忆：

**一、已完成的任务闭环**（kind 省略或填 "task"）

判断标准：
- 用户提出了明确的需求或问题
- 给出了解决方案或回答
- 结果明确（成功、部分完成、失败）

```memory-memo
{
  "userNeed": "<用户需求/目标，一句话概括>",
  "approach": "<执行方案，做了什么，2-4 句话>",
  "outcome": "<最终结果，如'完成'、'部分完成'、'失败：原因'>",
  "whatFailed": "<踩坑记录：试了但不行的路，无则填 'none'>",
  "whatWorked": "<成功经验：最终奏效的关键动作，无则填 'none'>",
  "tags": ["<标签1>", "<标签2>", "<标签3>"]
}
```

**二、用户偏好与习惯**（kind = "preference"）

当用户明确表达或反复表现出**稳定的**偏好、习惯、工作方式时（例如：常用工具链、回答语言与风格、流程习惯、"以后都/每次都…"类要求），输出偏好记录：

```memory-memo
{
  "kind": "preference",
  "userNeed": "<适用场景，一句话；跨项目通用则写'所有会话'>",
  "approach": "<偏好规则本身，一句话，写成可直接遵循的要求>",
  "outcome": "已记录为长期偏好",
  "whatFailed": "none",
  "whatWorked": "none",
  "tags": ["偏好", "<领域标签>"]
}
```

偏好判定要宁缺毋滥：
- 只记录稳定、可复用的习惯，不记录一次性要求（"这次用 X"）或临时上下文
- 用户对既有偏好的纠正也要记录（写清新规则）
- 每条偏好独立成块，不要与任务经验合并

**三、未完成事项**（kind = "pending"）

仅当本次会话存在**明确未完成**的工作时输出：任务做到一半被打断、用户表示"下次继续 / 先到这里"、或已经开始但尚未收尾。任务已经完成并交付、用户表示满意、或只是日常问答时，不要输出。

```memory-memo
{
  "kind": "pending",
  "userNeed": "<任务本身，一句话，如'修复 XXX 的启动崩溃'>",
  "approach": "<当前进度与下一步：做到哪了、卡在哪、下一步是什么，2-4 句话>",
  "outcome": "未完成",
  "whatFailed": "<已尝试但无效的路径，无则填 'none'>",
  "whatWorked": "<已验证有效的动作，无则填 'none'>",
  "tags": ["<标签1>", "<标签2>", "<标签3>"]
}
```

未完成判定要宁缺毋滥：
- 只有任务明显还需要继续时才输出；话题自然结束、用户没有表达继续意愿时按完成处理
- 同一任务只输出一条，不要拆成多条

__PENDING__注意：
- tags 是 3-5 个语义标签，概括任务领域/技术栈/动作类型，例如 ["react", "auth", "部署"]
- whatFailed 记录重要的错误尝试，帮助未来避免重蹈覆辙
- whatWorked 记录最终成功的关键动作，帮助未来复用经验
- 未完成的工作不写入任务经验；如有需要保留的未完成事项，按第三节单独输出
- 将紧密相关的子任务合并为一条记录
- 严格遵守上述字段名和 JSON 格式，不要添加额外字段

如果既没有已完成的任务闭环，也没有新的稳定偏好，也没有未完成事项，输出：
```memory-memo
{"none": true}
```

--- 对话记录（最近 30 条消息）---

__SAMPLE__

--- 对话记录结束 ---"#;

    HEAD.replace("__SESSION__", session_id)
        .replace("__COUNT__", &message_count.to_string())
        .replace("__PENDING__", &render_pending_section(pending_tasks))
        .replace("__SAMPLE__", sample_text)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
}

/// Bodies of ```lang ... ``` fences. The header line may carry trailing text.
/// A fence without a newline after the header, or without a closing fence, is dropped.
fn fenced_bodies<'a>(text: &'a str, lang: &str) -> Vec<&'a str> {
    let needle = format!("```{lang}");
    let mut bodies = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find(&needle) {
        let after = &rest[index + needle.len()..];
        let Some(newline) = after.find('\n') else {
            break;
        };
        let tail = &after[newline + 1..];
        let Some(close) = tail.find("```") else {
            break;
        };
        bodies.push(&tail[..close]);
        rest = &tail[close + 3..];
    }
    bodies
}

fn render_pending_section(pending_tasks: Option<&[PendingTaskRef]>) -> String {
    let Some(tasks) = pending_tasks.filter(|tasks| !tasks.is_empty()) else {
        return String::new();
    };
    let lines = tasks
        .iter()
        .map(|task| format!("- {}｜{}", task.id, truncate_pending_task(&task.user_need)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"**四、待续事项销账**（可选）

以下是此前记录的、仍未完成的待续事项（格式：id｜任务）：

{lines}

如果本次会话**明确完成**了其中某一项（工作已交付、结果已达成、或用户确认完成），在 memory-memo 块之外额外输出一个销账块：

```memory-resolve
{{"resolved": ["<完成的 id>"]}}
```

销账判定要宁缺毋滥：
- 只列本次会话确凿完成的 id；部分完成、不确定、只是提到但没有做完的，一律不列
- id 必须原样取自上方清单，不要编造、不要改写
- 即使本次没有其它记忆要写，只要完成了清单中的事项，也照常输出销账块
- 销账不影响第一节：完成的工作仍可按第一节提炼为任务经验
- 没有任何一项完成时，不要输出销账块

"#,
        lines = lines,
    )
}

fn truncate_pending_task(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_PENDING_TASK_CHARS {
        collapsed
    } else {
        let trimmed: String = collapsed.chars().take(MAX_PENDING_TASK_CHARS).collect();
        format!("{trimmed}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo_block(body: &str) -> String {
        format!("```memory-memo\n{body}\n```")
    }

    #[test]
    fn parses_valid_blocks_and_keeps_failure_notes() {
        let text = r#"
## Current Focus
Working on auth module

```memory-memo
{
  "userNeed": "修复 OAuth 401",
  "approach": "增加 token 刷新重试",
  "outcome": "完成",
  "whatFailed": "无限重试导致死循环，加了 max retries",
  "whatWorked": "加了 max retries 限制"
}
```

```memory-memo
{
  "userNeed": "优化编译速度",
  "approach": "升级 tsdown，启用并行编译",
  "outcome": "部分完成",
  "whatFailed": "none",
  "whatWorked": "none"
}
```
"#;
        let memos = parse_memory_memos(text);
        assert_eq!(memos.len(), 2);
        assert!(memos[0].user_need.contains("OAuth"));
        assert_eq!(memos[0].outcome, "完成");
        assert_eq!(memos[0].what_failed, "无限重试导致死循环，加了 max retries");
        assert_eq!(memos[0].what_worked, "加了 max retries 限制");
        assert_eq!(memos[0].extraction_source, "compaction");
        assert_eq!(memos[0].source_session_id, "");
        assert_eq!(memos[1].outcome, "部分完成");
    }

    #[test]
    fn skips_none_sentinel_malformed_json_and_missing_user_need() {
        assert!(parse_memory_memos("```memory-memo\n{\"none\": true}\n```").is_empty());
        assert!(parse_memory_memos("```memory-memo\n{not valid json}\n```").is_empty());
        assert!(
            parse_memory_memos("```memory-memo\n{\"approach\": \"something\"}\n```").is_empty()
        );
        assert!(parse_memory_memos("```memory-memo\n{\"userNeed\": \"   \"}\n```").is_empty());
    }

    #[test]
    fn parses_crlf_blocks_and_a_blank_line_under_the_header() {
        let crlf = [
            "```memory-memo",
            "{",
            "  \"userNeed\": \"修复 CRLF 解析\",",
            "  \"approach\": \"在 Windows 上测试\",",
            "  \"outcome\": \"完成\"",
            "}",
            "```",
        ]
        .join("\r\n");
        let memos = parse_memory_memos(&crlf);
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "修复 CRLF 解析");
        assert_eq!(memos[0].outcome, "完成");

        let blank = "```memory-memo\n\n{\"userNeed\": \"blank line\", \"approach\": \"x\", \"outcome\": \"完成\"}\n\n```";
        let memos = parse_memory_memos(blank);
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "blank line");
    }

    #[test]
    fn keeps_a_later_valid_block_when_an_earlier_one_is_malformed() {
        let text = concat!(
            "```memory-memo\n{ not valid json }\n```\n\n",
            "```memory-memo\n{\"userNeed\": \"second block\", \"approach\": \"x\", \"outcome\": \"完成\"}\n```"
        );
        let memos = parse_memory_memos(text);
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "second block");
    }

    #[test]
    fn skips_the_none_sentinel_without_dropping_a_real_sibling() {
        let text = concat!(
            "```memory-memo\n{\"none\": true}\n```\n\n",
            "```memory-memo\n{\"userNeed\": \"real work\", \"approach\": \"x\", \"outcome\": \"完成\"}\n```"
        );
        let memos = parse_memory_memos(text);
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].user_need, "real work");
    }

    #[test]
    fn tags_follow_the_array_contract() {
        let tagged = memo_block(
            "{\"userNeed\": \"fix auth\", \"approach\": \"x\", \"outcome\": \"完成\", \"tags\": [\"React\", \"auth\"]}",
        );
        assert_eq!(parse_memory_memos(&tagged)[0].tags, vec!["react", "auth"]);

        let missing =
            memo_block("{\"userNeed\": \"test\", \"approach\": \"x\", \"outcome\": \"完成\"}");
        assert!(parse_memory_memos(&missing)[0].tags.is_empty());

        let not_array = memo_block(
            "{\"userNeed\": \"bad tags\", \"approach\": \"x\", \"outcome\": \"完成\", \"tags\": \"react,auth\"}",
        );
        assert!(parse_memory_memos(&not_array)[0].tags.is_empty());

        let mixed = memo_block(
            "{\"userNeed\": \"mixed tags\", \"approach\": \"x\", \"outcome\": \"完成\", \"tags\": [\"react\", 42, null, \"auth\"]}",
        );
        assert_eq!(
            parse_memory_memos(&mixed)[0].tags,
            vec!["react".to_string(), "auth".to_string()]
        );
    }

    #[test]
    fn defaults_missing_failure_fields_and_reads_blocks_inside_prose() {
        let text =
            memo_block("{\"userNeed\": \"defaults\", \"approach\": \"x\", \"outcome\": \"完成\"}");
        let memos = parse_memory_memos(&text);
        assert_eq!(memos[0].what_failed, "none");
        assert_eq!(memos[0].what_worked, "none");

        let embedded = concat!(
            "Here is my summary of the session.\n\n",
            "Some narrative about what happened.\n\n",
            "```memory-memo\n{\"userNeed\": \"embedded\", \"approach\": \"x\", \"outcome\": \"完成\"}\n```\n\n",
            "And some closing remarks."
        );
        assert_eq!(parse_memory_memos(embedded)[0].user_need, "embedded");
        assert!(parse_memory_memos("just a plain summary with no blocks").is_empty());
        assert!(parse_memory_memos("").is_empty());
    }

    #[test]
    fn kinds_survive_when_known_and_degrade_otherwise() {
        let preference = memo_block(
            "{\"kind\": \"preference\", \"userNeed\": \"所有会话\", \"approach\": \"回复用中文\", \"outcome\": \"已记录为长期偏好\", \"whatFailed\": \"none\", \"whatWorked\": \"none\", \"tags\": [\"偏好\", \"沟通\"]}",
        );
        let memos = parse_memory_memos(&preference);
        assert_eq!(memos[0].kind, MemoKind::Preference);
        assert_eq!(memos[0].approach, "回复用中文");

        let pending = memo_block(
            "{\"kind\": \"pending\", \"userNeed\": \"修复 flaky test\", \"approach\": \"已定位到 Win 文件锁\", \"outcome\": \"未完成\", \"whatFailed\": \"none\", \"whatWorked\": \"none\", \"tags\": [\"测试\", \"稳定性\"]}",
        );
        let memos = parse_memory_memos(&pending);
        assert_eq!(memos[0].kind, MemoKind::Pending);
        assert_eq!(memos[0].outcome, "未完成");

        let task = memo_block(
            "{\"userNeed\": \"修复构建\", \"approach\": \"升级依赖\", \"outcome\": \"完成\"}",
        );
        assert_eq!(parse_memory_memos(&task)[0].kind, MemoKind::Task);

        let unknown = memo_block(
            "{\"kind\": \"habit\", \"userNeed\": \"x\", \"approach\": \"y\", \"outcome\": \"完成\"}",
        );
        assert_eq!(parse_memory_memos(&unknown)[0].kind, MemoKind::Task);
    }

    #[test]
    fn resolved_ids_merge_dedupe_and_ignore_junk() {
        assert_eq!(
            parse_resolved_pending_ids(
                "```memory-resolve\n{\"resolved\": [\"memo-a\", \"memo-b\"]}\n```"
            ),
            vec!["memo-a", "memo-b"]
        );

        let merged = concat!(
            "```memory-resolve\n{\"resolved\": [\"memo-b\", \"memo-a\"]}\n```\n\n",
            "```memory-resolve\n{\"resolved\": [\"memo-a\", \"memo-c\"]}\n```"
        );
        assert_eq!(
            parse_resolved_pending_ids(merged),
            vec!["memo-b", "memo-a", "memo-c"]
        );

        let junk = concat!(
            "```memory-resolve\n{ not valid json }\n```\n\n",
            "```memory-resolve\n{\"resolved\": \"memo-a\"}\n```\n\n",
            "```memory-resolve\n{\"resolved\": [\"\", \"  \", 42, null, \"memo-ok\"]}\n```"
        );
        assert_eq!(parse_resolved_pending_ids(junk), vec!["memo-ok"]);

        let crlf = [
            "Summary follows.",
            "```memory-resolve",
            "{\"resolved\": [\"memo-crlf\"]}",
            "```",
            "Closing remarks.",
        ]
        .join("\r\n");
        assert_eq!(parse_resolved_pending_ids(&crlf), vec!["memo-crlf"]);

        assert!(parse_resolved_pending_ids("no blocks here").is_empty());
        assert!(parse_resolved_pending_ids("").is_empty());
        assert!(
            parse_resolved_pending_ids("```memory-memo\n{\"userNeed\": \"x\"}\n```").is_empty()
        );
    }

    #[test]
    fn exit_prompt_includes_the_sample_and_optional_pending_section() {
        let prompt = build_exit_extraction_prompt(
            "sess-123",
            50,
            "[user] fix the bug\n[assistant] done",
            None,
        );
        assert!(prompt.contains("sess-123"));
        assert!(prompt.contains("共 50 条消息"));
        assert!(prompt.contains("[user] fix the bug"));
        assert!(prompt.contains("[assistant] done"));
        assert!(prompt.contains("已完成的任务闭环"));
        assert!(prompt.contains("对话记录"));
        assert!(!prompt.contains("待续事项销账"));
        assert!(!prompt.contains("memory-resolve"));

        let with_pending = build_exit_extraction_prompt(
            "sess-1",
            5,
            "[user] continue",
            Some(&[
                PendingTaskRef {
                    id: "memo-abc".to_string(),
                    user_need: "修复 flaky test".to_string(),
                },
                PendingTaskRef {
                    id: "memo-def".to_string(),
                    user_need: "升级 CI 缓存".to_string(),
                },
            ]),
        );
        assert!(with_pending.contains("待续事项销账"));
        assert!(with_pending.contains("- memo-abc｜修复 flaky test"));
        assert!(with_pending.contains("- memo-def｜升级 CI 缓存"));
        assert!(with_pending.contains("memory-resolve"));
        assert!(with_pending.contains("{\"resolved\": [\"<完成的 id>\"]}"));

        let empty = build_exit_extraction_prompt("sess-1", 5, "sample", Some(&[]));
        assert!(!empty.contains("待续事项销账"));
    }

    #[test]
    fn long_pending_text_is_collapsed_and_truncated() {
        let user_need = format!("修复\n  换行   任务{}", "x".repeat(200));
        let prompt = build_exit_extraction_prompt(
            "sess-1",
            5,
            "sample",
            Some(&[PendingTaskRef {
                id: "memo-long".to_string(),
                user_need,
            }]),
        );
        let line = prompt
            .lines()
            .find(|candidate| candidate.starts_with("- memo-long｜"))
            .expect("pending line");
        assert!(line.chars().count() < 140);
        assert!(line.ends_with('…'));
        assert!(line.contains("修复 换行 任务"));
    }

    #[test]
    fn system_prompt_matches_the_typescript_instruction() {
        assert!(
            EXIT_EXTRACTION_SYSTEM_PROMPT.contains("只输出指定的 JSON 格式，不要调用任何工具。")
        );
        assert!(EXIT_EXTRACTION_SYSTEM_PROMPT.contains("销账块"));
    }
}
