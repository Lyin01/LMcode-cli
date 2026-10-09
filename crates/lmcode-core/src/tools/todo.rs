//! `TodoList` — replace, clear, or read the session todo list.
//!
//! The TypeScript tool is `TodoList` (the migration inventory called the
//! same behavior TodoWrite). Omit `todos` to read, pass `[]` to clear, or
//! pass the full list to replace it.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::Tool;

const DESCRIPTION: &str = include_str!("todo-list.md");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub title: String,
    pub status: String,
}

/// Shared todo list. The tool and later injectors hold the same handle.
#[derive(Clone, Default)]
pub struct TodoList {
    items: Arc<Mutex<Vec<TodoItem>>>,
}

impl TodoList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn items(&self) -> Vec<TodoItem> {
        self.items.lock().expect("todo list lock").clone()
    }
}

pub struct TodoListTool {
    list: TodoList,
}

impl TodoListTool {
    pub fn new(list: TodoList) -> Self {
        Self { list }
    }
}

fn status_marker(status: &str) -> String {
    format!("[{status}]")
}

fn render(items: &[TodoItem]) -> String {
    if items.is_empty() {
        return "Todo list is empty.".to_string();
    }
    let mut lines = vec!["Current todo list:".to_string()];
    for item in items {
        lines.push(format!("  {} {}", status_marker(&item.status), item.title));
    }
    lines.join("\n")
}

fn parse_items(value: &Value) -> Result<Vec<TodoItem>, String> {
    let array = value
        .as_array()
        .ok_or("todos must be an array of {title, status}")?;
    let mut items = Vec::with_capacity(array.len());
    for (index, item) in array.iter().enumerate() {
        let title = item["title"]
            .as_str()
            .filter(|title| !title.is_empty())
            .ok_or_else(|| format!("todo {} needs a non-empty title", index + 1))?
            .to_string();
        let status = item["status"]
            .as_str()
            .ok_or_else(|| format!("todo {} needs a status", index + 1))?;
        if !matches!(status, "pending" | "in_progress" | "done") {
            return Err(format!(
                "todo {} status must be pending, in_progress, or done",
                index + 1
            ));
        }
        items.push(TodoItem {
            title,
            status: status.to_string(),
        });
    }
    Ok(items)
}

#[async_trait]
impl Tool for TodoListTool {
    fn name(&self) -> &str {
        "TodoList"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "done"], "description": "Current status of the todo." }
                        },
                        "required": ["title", "status"]
                    }
                }
            }
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    fn todo_items(&self) -> Option<Vec<TodoItem>> {
        Some(self.list.items())
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        if !arguments
            .as_object()
            .is_some_and(|object| object.contains_key("todos"))
        {
            return Ok(render(&self.list.items()));
        }
        let items = parse_items(&arguments["todos"])?;
        if items.is_empty() {
            *self.list.items.lock().expect("todo list lock") = Vec::new();
            return Ok("Todo list cleared.".to_string());
        }
        let rendered = render(&items);
        *self.list.items.lock().expect("todo list lock") = items;
        Ok(format!("Todo list updated.\n{rendered}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_and_description_keep_the_churn_guardrails() {
        let tool = TodoListTool::new(TodoList::new());
        assert_eq!(tool.name(), "TodoList");
        assert!(tool.description().contains("**Avoid churn:**"));
        assert!(
            tool.description()
                .to_lowercase()
                .contains("nothing meaningful has changed")
        );
        assert!(tool.description().to_lowercase().contains("real progress"));
        assert!(tool.description().to_lowercase().contains("query mode"));
        assert!(tool.description().to_lowercase().contains("tell the user"));
        assert!(
            tool.description()
                .contains("prompts with many explicit requirements")
        );
        assert!(tool.description().contains("direct answers"));
        assert!(tool.description().contains("acceptance criteria"));
        assert!(tool.description().contains("constraints"));
        assert!(tool.description().contains("exclusions"));
        assert!(tool.description().contains("parenthetical clauses"));
        assert!(
            tool.description()
                .contains("capability/visibility/control constraints")
        );
        assert!(tool.description().contains("observable/control details"));
        assert!(tool.description().contains("Before the final answer"));
        let schema = tool.parameters_schema();
        assert_eq!(schema["properties"]["todos"]["type"], "array");
        assert!(!tool.requires_approval());
    }

    #[tokio::test]
    async fn query_renders_without_mutating_and_done_uses_the_enum_marker() {
        let list = TodoList::new();
        {
            let mut items = list.items.lock().unwrap();
            items.push(TodoItem {
                title: "shipped".to_string(),
                status: "done".to_string(),
            });
        }
        let tool = TodoListTool::new(list.clone());
        let output = tool.execute(&json!({}), Path::new(".")).await.unwrap();
        assert!(output.contains("Current todo list"));
        assert!(output.contains("[done] shipped"));
        assert!(!output.contains("[completed]"));
        assert_eq!(list.items()[0].title, "shipped");
    }

    #[tokio::test]
    async fn write_replaces_the_list_and_clear_empties_it() {
        let list = TodoList::new();
        let tool = TodoListTool::new(list.clone());
        let written = tool
            .execute(
                &json!({
                    "todos": [
                        {"title": "first", "status": "pending"},
                        {"title": "second", "status": "in_progress"}
                    ]
                }),
                Path::new("."),
            )
            .await
            .unwrap();
        assert!(written.contains("Todo list updated"));
        assert!(written.contains("[pending] first"));
        assert!(written.contains("[in_progress] second"));
        assert_eq!(list.items().len(), 2);

        let cleared = tool
            .execute(&json!({"todos": []}), Path::new("."))
            .await
            .unwrap();
        assert_eq!(cleared, "Todo list cleared.");
        assert!(list.items().is_empty());
    }

    #[tokio::test]
    async fn rejects_an_unknown_status() {
        let tool = TodoListTool::new(TodoList::new());
        let error = tool
            .execute(
                &json!({"todos": [{"title": "x", "status": "wip"}]}),
                Path::new("."),
            )
            .await
            .unwrap_err();
        assert!(error.contains("status"), "{error}");
    }
}
