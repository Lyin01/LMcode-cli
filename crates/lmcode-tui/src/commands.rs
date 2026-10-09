//! Slash command parsing for the TUI.

/// Commands understood by the TUI input line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashCommand {
    Help,
    Clear,
    Exit,
    Model,
    Sessions,
    Mcp,
    Usage,
}

impl SlashCommand {
    /// Parse an input line; `None` when it is not a slash command.
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        let name = trimmed.strip_prefix('/')?;
        let name = name
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match name.as_str() {
            "help" => Some(Self::Help),
            "clear" => Some(Self::Clear),
            "exit" | "quit" => Some(Self::Exit),
            "model" | "models" => Some(Self::Model),
            "sessions" => Some(Self::Sessions),
            "mcp" => Some(Self::Mcp),
            "usage" => Some(Self::Usage),
            _ => None,
        }
    }
}

/// Help text shown by `/help`.
pub const HELP_TEXT: &str = "\
/help      show this help
/clear     clear conversation history
/model     switch the active model
/sessions  list and resume sessions
/mcp       list connected MCP servers
/usage     show session token usage
/exit      quit";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_commands_with_aliases_and_whitespace() {
        assert_eq!(SlashCommand::parse("/help"), Some(SlashCommand::Help));
        assert_eq!(SlashCommand::parse("  /quit  "), Some(SlashCommand::Exit));
        assert_eq!(SlashCommand::parse("/models"), Some(SlashCommand::Model));
        assert_eq!(
            SlashCommand::parse("/sessions extra args"),
            Some(SlashCommand::Sessions)
        );
        assert_eq!(SlashCommand::parse("/mcp"), Some(SlashCommand::Mcp));
        assert_eq!(SlashCommand::parse("/usage"), Some(SlashCommand::Usage));
    }

    #[test]
    fn rejects_non_commands_and_unknown_names() {
        assert_eq!(SlashCommand::parse("hello"), None);
        assert_eq!(SlashCommand::parse("/nope"), None);
        assert_eq!(SlashCommand::parse(""), None);
        assert_eq!(SlashCommand::parse("/"), None);
    }
}
