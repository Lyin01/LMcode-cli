//! `AskUserQuestion` — structured questions for the user.
//!
//! The turn loop dispatches the question through [`crate::agent::TurnUi`]
//! before this tool's `execute` runs. `execute` is the fallback for a caller
//! that has no UI: it still validates, then tells the model not to retry.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::Tool;

/// Shown when the user closes the question without choosing.
pub const QUESTION_DISMISSED_NOTE: &str = "User dismissed the question without answering.";

/// Shown when the connected client cannot present a question dialog.
pub const QUESTION_UNSUPPORTED_MESSAGE: &str = "The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.";

const DESCRIPTION: &str = "\
Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.

**Usage notes:**
- Users always have an \"Other\" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words), use descriptions for trade-offs and details
- Each question should have 2-4 meaningful, distinct options
- You can ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend a specific option, list it first and append \"(Recommended)\" to its label";

/// One choice inside a question. The tool must not invent an "Other" option.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserQuestionOption {
    pub label: String,
    pub description: String,
}

/// One structured question passed to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<UserQuestionOption>,
    pub multi_select: bool,
}

/// What the UI returned. `Payload` is the raw client value, before shaping.
#[derive(Debug, Clone, PartialEq)]
pub enum AskUserAnswer {
    /// JSON null, a bare answers object, or `{ "answers", "method" }`.
    Payload(Value),
    Unsupported,
    Failed(String),
}

/// Validate the tool arguments. Missing `header`, `description`, and
/// `multi_select` take their TypeScript defaults.
pub fn parse_questions(arguments: &Value) -> Result<Vec<UserQuestion>, String> {
    let questions = arguments
        .get("questions")
        .and_then(Value::as_array)
        .ok_or("AskUserQuestion requires a questions array")?;
    if questions.is_empty() || questions.len() > 4 {
        return Err("AskUserQuestion accepts 1-4 questions".to_string());
    }
    let mut parsed = Vec::with_capacity(questions.len());
    for (index, item) in questions.iter().enumerate() {
        let object = item
            .as_object()
            .ok_or_else(|| format!("question {} must be an object", index + 1))?;
        let question = object
            .get("question")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("question {} is missing `question`", index + 1))?
            .to_string();
        let header = match object.get("header") {
            None => String::new(),
            Some(value) => value
                .as_str()
                .ok_or_else(|| format!("question {} header must be a string", index + 1))?
                .to_string(),
        };
        let multi_select = match object.get("multi_select") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(format!(
                    "question {} multi_select must be a boolean",
                    index + 1
                ));
            }
        };
        let options = object
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("question {} must have 2-4 options", index + 1))?;
        if !(2..=4).contains(&options.len()) {
            return Err(format!("question {} must have 2-4 options", index + 1));
        }
        let mut parsed_options = Vec::with_capacity(options.len());
        for (option_index, option) in options.iter().enumerate() {
            let option = option.as_object().ok_or_else(|| {
                format!(
                    "question {} option {} must be an object",
                    index + 1,
                    option_index + 1
                )
            })?;
            let label = option
                .get("label")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!(
                        "question {} option {} is missing `label`",
                        index + 1,
                        option_index + 1
                    )
                })?
                .to_string();
            let description = match option.get("description") {
                None => String::new(),
                Some(value) => value
                    .as_str()
                    .ok_or_else(|| {
                        format!(
                            "question {} option {} description must be a string",
                            index + 1,
                            option_index + 1
                        )
                    })?
                    .to_string(),
            };
            parsed_options.push(UserQuestionOption { label, description });
        }
        parsed.push(UserQuestion {
            question,
            header,
            options: parsed_options,
            multi_select,
        });
    }
    Ok(parsed)
}

/// Shape a UI answer into the tool result. Dismissal is success.
/// `method` is stripped so it does not leak to the model.
pub fn format_ask_user_result(answer: AskUserAnswer) -> (String, bool) {
    match answer {
        AskUserAnswer::Unsupported => (QUESTION_UNSUPPORTED_MESSAGE.to_string(), false),
        AskUserAnswer::Failed(message) => (format!("Failed to ask the user: {message}"), false),
        AskUserAnswer::Payload(value) => match answers_from_payload(&value) {
            Some(answers) if answers.as_object().is_some_and(|map| !map.is_empty()) => {
                (json!({ "answers": answers }).to_string(), true)
            }
            _ => (
                json!({
                    "answers": {},
                    "note": QUESTION_DISMISSED_NOTE,
                })
                .to_string(),
                true,
            ),
        },
    }
}

fn answers_from_payload(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Object(map) => match map.get("answers") {
            Some(answers) if answers.is_object() => Some(answers.clone()),
            Some(_) => None,
            None => Some(Value::Object(map.clone())),
        },
        _ => None,
    }
}

fn parameters_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 4,
                "description": "The questions to ask the user (1-4 questions).",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "A specific, actionable question. End with '?'."
                        },
                        "header": {
                            "type": "string",
                            "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style')."
                        },
                        "options": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 4,
                            "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {
                                        "type": "string",
                                        "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'."
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "Brief explanation of trade-offs or implications."
                                    }
                                },
                                "required": ["label"]
                            }
                        },
                        "multi_select": {
                            "type": "boolean",
                            "description": "Whether the user can select multiple options."
                        }
                    },
                    "required": ["question", "options"]
                }
            }
        },
        "required": ["questions"]
    })
}

/// Structured question tool. The turn loop asks the user; `execute` only
/// validates and reports that no dialog is available.
pub struct AskUserQuestionTool;

impl AskUserQuestionTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for AskUserQuestionTool {
    fn name(&self) -> &str {
        "AskUserQuestion"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters_schema(&self) -> Value {
        parameters_schema()
    }

    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(&self, arguments: &Value, _cwd: &Path) -> Result<String, String> {
        parse_questions(arguments)?;
        Err(QUESTION_UNSUPPORTED_MESSAGE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    fn sample() -> Value {
        json!({
            "questions": [{
                "question": "Which database?",
                "header": "Storage",
                "options": [
                    {"label": "Postgres", "description": "Relational storage"},
                    {"label": "SQLite", "description": "Embedded storage"}
                ],
                "multi_select": false
            }]
        })
    }

    #[test]
    fn schema_describes_the_other_rule_and_the_recommended_hint() {
        let tool = AskUserQuestionTool::new();
        assert_eq!(tool.name(), "AskUserQuestion");
        assert!(tool.description().contains("structured options"));
        assert!(!tool.requires_approval());
        let schema = tool.parameters_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["properties"]["questions"]["type"], "array");
        let options = &schema["properties"]["questions"]["items"]["properties"]["options"];
        let options_description = options["description"].as_str().unwrap();
        assert!(options_description.contains("Do NOT include an 'Other' option"));
        assert!(options_description.contains("the system adds one automatically"));
        let label = options["items"]["properties"]["label"]["description"]
            .as_str()
            .unwrap();
        assert!(label.contains("append '(Recommended)'"));
    }

    #[test]
    fn parses_defaults_and_rejects_the_size_limits() {
        let questions = parse_questions(&sample()).unwrap();
        assert_eq!(questions[0].question, "Which database?");
        assert_eq!(questions[0].header, "Storage");
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options[0].label, "Postgres");

        let defaults = parse_questions(&json!({
            "questions": [{
                "question": "Which?",
                "options": [{"label": "A"}, {"label": "B"}]
            }]
        }))
        .unwrap();
        assert_eq!(defaults[0].header, "");
        assert_eq!(defaults[0].options[0].description, "");
        assert!(!defaults[0].multi_select);

        assert!(parse_questions(&json!({"questions": []})).is_err());
        assert!(
            parse_questions(&json!({
                "questions": [{
                    "question": "Which?",
                    "options": [{"label": "Only one", "description": "Not enough choices"}]
                }]
            }))
            .is_err()
        );
    }

    #[test]
    fn shapes_answers_dismissal_and_failures() {
        let (output, ok) =
            format_ask_user_result(AskUserAnswer::Payload(json!({"Postgres": true})));
        assert!(ok);
        assert_eq!(output, r#"{"answers":{"Postgres":true}}"#);

        let (output, ok) = format_ask_user_result(AskUserAnswer::Payload(json!({
            "answers": {"Which database?": "SQLite"},
            "method": "number_key"
        })));
        assert!(ok);
        assert_eq!(output, r#"{"answers":{"Which database?":"SQLite"}}"#);
        assert!(!output.contains("number_key"));

        let (output, ok) = format_ask_user_result(AskUserAnswer::Payload(Value::Null));
        assert!(ok);
        assert!(output.contains("dismissed"));
        assert!(output.contains("answers"));
        assert!(output.contains(QUESTION_DISMISSED_NOTE));

        let (output, ok) = format_ask_user_result(AskUserAnswer::Payload(json!({"answers": {}})));
        assert!(ok);
        assert!(output.contains("dismissed"));

        let (output, ok) = format_ask_user_result(AskUserAnswer::Failed(
            "JSON-RPC question error response".into(),
        ));
        assert!(!ok);
        assert!(output.contains("Failed to ask the user"));
        assert!(output.contains("JSON-RPC question error response"));

        let (output, ok) = format_ask_user_result(AskUserAnswer::Unsupported);
        assert!(!ok);
        assert!(output.contains("connected client"));
        assert!(output.contains("does not support interactive questions"));
        assert!(output.contains("Do NOT call this tool again"));
        assert!(output.contains("Ask the user directly in your text response instead"));
    }
}
