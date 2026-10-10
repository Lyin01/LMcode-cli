//! `Bash` tool — run a shell command and capture its combined output.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_OUTPUT_LINES: usize = 400;

pub struct BashTool {
    background: Option<std::sync::Arc<crate::background::BackgroundTaskManager>>,
}

impl BashTool {
    pub fn new() -> Self {
        Self { background: None }
    }

    /// Variant wired to the background task manager (`run_in_background`).
    pub fn with_background(
        manager: std::sync::Arc<crate::background::BackgroundTaskManager>,
    ) -> Self {
        Self {
            background: Some(manager),
        }
    }
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    fn description(&self) -> &str {
        "Run a shell command in the working directory and return its combined output. \
         Windows: runs through Git Bash (`bash -c`). Unix: `sh -c`. Set \
         `run_in_background` for long-running commands (dev servers, watches); \
         read them back with the TaskOutput tool."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute"
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Timeout in milliseconds (default 120000, max 600000)"
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Start the command detached and return immediately with a task id."
                }
            },
            "required": ["command"]
        })
    }

    fn unrestricted(&self) -> bool {
        true
    }

    async fn execute(&self, arguments: &serde_json::Value, cwd: &Path) -> Result<String, String> {
        let command = arguments["command"]
            .as_str()
            .ok_or("missing `command` argument")?;
        if arguments["run_in_background"].as_bool() == Some(true) {
            let manager = self
                .background
                .as_ref()
                .ok_or("background tasks are not available in this configuration")?;
            let info = manager.spawn(command, cwd)?;
            return Ok(format!(
                "background task started: {}\noutput log: {}\nUse the TaskOutput tool to read its status and output.",
                info.id, info.output_path
            ));
        }
        let timeout_ms = arguments["timeout_ms"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);

        let mut shell = shell_command();
        shell
            .arg(command)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = shell
            .spawn()
            .map_err(|error| format!("failed to spawn shell: {error}"))?;
        let output =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
                .await
            {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => return Err(format!("failed to run command: {error}")),
                Err(_) => return Err(format!("command timed out after {timeout_ms} ms")),
            };

        let mut combined = String::new();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stdout.is_empty() {
            combined.push_str(&stdout);
        }
        if !stderr.is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&stderr);
        }
        if !output.status.success() {
            let code = output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated by signal".to_string());
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&format!("[exit code: {code}]"));
        }
        if combined.trim().is_empty() {
            combined.push_str("(no output)");
        }
        Ok(truncate_lines(&combined, MAX_OUTPUT_LINES))
    }
}

fn shell_command() -> tokio::process::Command {
    if cfg!(windows) {
        for path in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if std::path::Path::new(path).exists() {
                let mut command = tokio::process::Command::new(path);
                command.arg("-c");
                return command;
            }
        }
        if let Ok(path_var) = std::env::var("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let bash = entry.join("bash.exe");
                if bash.is_file() {
                    let mut command = tokio::process::Command::new(bash);
                    command.arg("-c");
                    return command;
                }
            }
        }
        let mut command = tokio::process::Command::new("powershell");
        command.args(["-NoProfile", "-Command"]);
        command
    } else {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c");
        command
    }
}

fn truncate_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max_lines {
        return text.to_string();
    }
    let head = max_lines / 2;
    let tail = max_lines - head;
    let mut output = String::new();
    for line in &lines[..head] {
        output.push_str(line);
        output.push('\n');
    }
    output.push_str(&format!(
        "... ({} lines omitted)\n",
        lines.len() - max_lines
    ));
    for line in &lines[lines.len() - tail..] {
        output.push_str(line);
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_keeping_head_and_tail() {
        let text: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let truncated = truncate_lines(&text, 10);
        assert!(truncated.contains("line 1\n"));
        assert!(truncated.contains("line 5\n"));
        assert!(truncated.contains("... (90 lines omitted)"));
        assert!(truncated.contains("line 100\n"));
        assert!(!truncated.contains("line 50\n"));
    }

    #[test]
    fn keeps_short_output_intact() {
        assert_eq!(truncate_lines("a\nb", 10), "a\nb");
    }
}
