//! Terminal rendering for the turn loop: streaming text, dim reasoning,
//! tool activity, and approval prompts.
//!
//! All output goes through `anstream`, which strips ANSI sequences when the
//! output is not a terminal and enables VT processing on Windows consoles.

use anstream::{eprintln, print, println};
use anstyle::{AnsiColor, Color, Style};
use lmcode_core::agent::TurnUi;

/// Accent style (brand cyan).
fn accent() -> Style {
    Style::new().fg_color(Some(Color::Ansi(AnsiColor::Cyan)))
}
/// Dim style for secondary text and reasoning output.
fn dim() -> Style {
    Style::new().fg_color(Some(Color::Ansi(AnsiColor::BrightBlack)))
}
fn green() -> Style {
    Style::new().fg_color(Some(Color::Ansi(AnsiColor::Green)))
}
fn red() -> Style {
    Style::new().fg_color(Some(Color::Ansi(AnsiColor::Red)))
}
fn yellow() -> Style {
    Style::new().fg_color(Some(Color::Ansi(AnsiColor::Yellow)))
}

/// Terminal UI sink.
pub struct TerminalUi {
    /// Whether a dim reasoning run is currently open (needs a style reset).
    thinking_open: bool,
    /// Skip approval prompts (non-interactive / automation mode).
    auto_approve: bool,
    /// Auto permission mode: non-sensitive calls are approved without
    /// prompting; calls touching sensitive paths still ask.
    auto_mode: bool,
}

impl TerminalUi {
    pub fn new() -> Self {
        Self {
            thinking_open: false,
            auto_approve: false,
            auto_mode: false,
        }
    }

    /// When enabled, every tool call is approved without prompting.
    pub fn set_auto_approve(&mut self, auto_approve: bool) {
        self.auto_approve = auto_approve;
    }

    /// Auto permission mode: approve anything that does not touch a
    /// sensitive path; sensitive calls still require an explicit answer.
    pub fn set_auto_mode(&mut self, auto_mode: bool) {
        self.auto_mode = auto_mode;
    }

    pub fn banner(&self, model: &str) {
        let accent = accent();
        let dim = dim();
        println!();
        println!("{accent}LMcode{accent:#} {dim}· Rust rewrite skeleton ·{dim:#} {model}");
        println!("{dim}/help for commands · Ctrl+C interrupts a response · /exit to quit{dim:#}");
        println!();
    }

    pub fn prompt(&self) {
        let accent = accent();
        print!("{accent}❯{accent:#} ");
        flush_stdout();
    }

    /// Close any open reasoning run and end the assistant's output block.
    pub fn finish_turn(&mut self) {
        if self.thinking_open {
            self.thinking_open = false;
            let dim = dim();
            print!("{dim:#}");
        }
        println!();
    }

    pub fn info(&self, message: &str) {
        let dim = dim();
        eprintln!("{dim}{message}{dim:#}");
    }

    pub fn error(&self, message: &str) {
        let red = red();
        eprintln!("{red}error:{red:#} {message}");
    }

    pub fn help(&self) {
        let accent = accent();
        let dim = dim();
        println!("{accent}commands{accent:#}");
        println!("  {dim}/help{dim:#}   show this help");
        println!("  {dim}/clear{dim:#}  clear conversation history");
        println!("  {dim}/sessions{dim:#}  list sessions for this directory");
        println!("  {dim}/exit{dim:#}   quit");
    }
}

#[async_trait::async_trait]
impl TurnUi for TerminalUi {
    async fn text_delta(&mut self, text: &str) {
        if self.thinking_open {
            self.thinking_open = false;
            let dim = dim();
            print!("\n{dim:#}");
        }
        print!("{text}");
        flush_stdout();
    }

    async fn think_delta(&mut self, text: &str) {
        let dim = dim();
        if !self.thinking_open {
            self.thinking_open = true;
            print!("\n{dim}💭 ");
        }
        print!("{dim}{text}{dim:#}");
        flush_stdout();
    }

    async fn tool_start(&mut self, name: &str, arguments: &str) {
        if self.thinking_open {
            self.thinking_open = false;
            let dim = dim();
            print!("{dim:#}");
        }
        let yellow = yellow();
        let dim = dim();
        println!(
            "\n{yellow}⚙ {name}{yellow:#} {dim}{}{dim:#}",
            truncate(arguments, 200)
        );
    }

    async fn tool_end(&mut self, name: &str, ok: bool, result: &str) {
        let (marker, style) = if ok { ("✓", green()) } else { ("✗", red()) };
        println!("  {style}{marker} {name}{style:#}");
        // Show a short preview of the tool output (dim), capped at 8 lines.
        let dim = dim();
        for line in result.lines().take(8) {
            println!("{dim}    {line}{dim:#}");
        }
        let total = result.lines().count();
        if total > 8 {
            println!("{dim}    … ({total} lines total){dim:#}");
        }
    }

    async fn approve(&mut self, name: &str, arguments: &str) -> bool {
        if self.auto_approve {
            let dim = dim();
            println!("{dim}  auto-approved {name}{dim:#}");
            return true;
        }
        if self.auto_mode {
            // Approve unless the call touches a sensitive path; arguments
            // that fail to parse are treated as sensitive (still asked).
            let sensitive = serde_json::from_str::<serde_json::Value>(arguments)
                .map(|parsed| lmcode_core::permission::call_touches_sensitive_path(&parsed))
                .unwrap_or(true);
            if !sensitive {
                let dim = dim();
                println!("{dim}  auto-approved {name}{dim:#}");
                return true;
            }
        }
        let yellow = yellow();
        let dim = dim();
        println!(
            "{yellow}  approve {name}?{yellow:#} {dim}{}{dim:#}",
            truncate(arguments, 300)
        );
        print!("  [y/N] ");
        flush_stdout();
        match read_line_async().await {
            Ok(Some(line)) => matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"),
            _ => false,
        }
    }

    async fn ask_user(
        &mut self,
        questions: &[lmcode_core::tools::ask_user::UserQuestion],
    ) -> lmcode_core::tools::ask_user::AskUserAnswer {
        // A question is the interaction. Auto-approve does not skip it.
        let mut answers = serde_json::Map::new();
        for (index, question) in questions.iter().enumerate() {
            let accent = accent();
            let dim = dim();
            println!();
            println!("{accent}Q{}{accent:#} {}", index + 1, question.question);
            if !question.header.is_empty() {
                println!("{dim}  {}{dim:#}", question.header);
            }
            for (option_index, option) in question.options.iter().enumerate() {
                println!("  {accent}{}{accent:#} {}", option_index + 1, option.label);
                if !option.description.is_empty() {
                    println!("{dim}     {}{dim:#}", option.description);
                }
            }
            let hint = if question.multi_select {
                "numbers separated by commas, or type your own answer"
            } else {
                "a number, or type your own answer"
            };
            print!("{dim}  {hint} (blank to dismiss): {dim:#}");
            flush_stdout();
            let line = match read_line_async().await {
                Ok(Some(line)) => line,
                Ok(None) => {
                    return lmcode_core::tools::ask_user::AskUserAnswer::Payload(
                        serde_json::Value::Null,
                    );
                }
                Err(error) => {
                    return lmcode_core::tools::ask_user::AskUserAnswer::Failed(error.to_string());
                }
            };
            if line.trim().is_empty() {
                return lmcode_core::tools::ask_user::AskUserAnswer::Payload(
                    serde_json::Value::Null,
                );
            }
            answers.insert(
                question.question.clone(),
                answer_value(line.trim(), question),
            );
        }
        lmcode_core::tools::ask_user::AskUserAnswer::Payload(serde_json::Value::Object(answers))
    }

    async fn notice(&mut self, message: &str) {
        let dim = dim();
        eprintln!("{dim}{message}{dim:#}");
    }
}

/// Map one readline onto an option label, a list of labels, or free text.
fn answer_value(
    line: &str,
    question: &lmcode_core::tools::ask_user::UserQuestion,
) -> serde_json::Value {
    let parts: Vec<&str> = line
        .split(|character: char| character == ',' || character.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect();
    let indexes: Option<Vec<usize>> = parts
        .iter()
        .map(|part| part.parse::<usize>().ok())
        .collect();
    if let Some(indexes) = indexes {
        let in_range = |index: usize| (1..=question.options.len()).contains(&index);
        if question.multi_select && !indexes.is_empty() && indexes.iter().copied().all(in_range) {
            return serde_json::Value::Array(
                indexes
                    .into_iter()
                    .map(|index| {
                        serde_json::Value::String(question.options[index - 1].label.clone())
                    })
                    .collect(),
            );
        }
        if !question.multi_select && indexes.len() == 1 && in_range(indexes[0]) {
            return serde_json::Value::String(question.options[indexes[0] - 1].label.clone());
        }
    }
    serde_json::Value::String(line.to_string())
}

/// Read one line from stdin on a blocking thread (async-safe).
pub async fn read_line_async() -> std::io::Result<Option<String>> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        let read = std::io::stdin().read_line(&mut line)?;
        if read == 0 { Ok(None) } else { Ok(Some(line)) }
    })
    .await
    .unwrap_or_else(|join_error| Err(std::io::Error::other(join_error)))
}

fn flush_stdout() {
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::answer_value;
    use lmcode_core::tools::ask_user::{UserQuestion, UserQuestionOption};

    fn question(multi_select: bool) -> UserQuestion {
        UserQuestion {
            question: "Which database?".to_string(),
            header: String::new(),
            options: vec![
                UserQuestionOption {
                    label: "Postgres".to_string(),
                    description: String::new(),
                },
                UserQuestionOption {
                    label: "SQLite".to_string(),
                    description: String::new(),
                },
            ],
            multi_select,
        }
    }

    #[test]
    fn numbered_answers_map_to_labels_and_other_text_passes_through() {
        let single = question(false);
        assert_eq!(answer_value("2", &single), serde_json::json!("SQLite"));
        assert_eq!(answer_value("9", &single), serde_json::json!("9"));
        assert_eq!(
            answer_value("sqlite on disk", &single),
            serde_json::json!("sqlite on disk")
        );

        let multi = question(true);
        assert_eq!(
            answer_value("1, 2", &multi),
            serde_json::json!(["Postgres", "SQLite"])
        );
        assert_eq!(
            answer_value("1 2", &multi),
            serde_json::json!(["Postgres", "SQLite"])
        );
        assert_eq!(
            answer_value("both, please", &multi),
            serde_json::json!("both, please")
        );
    }
}
