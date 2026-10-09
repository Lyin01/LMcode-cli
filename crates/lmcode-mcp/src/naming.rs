//! Tool naming — mirrors `packages/agent-core/src/mcp/tool-naming.ts`.
//!
//! Qualified names look like `mcp__<server>__<tool>`; characters outside the
//! safe ASCII set become `_` (runs collapsed), and names longer than 64 chars
//! are truncated with a stable FNV-1a hash suffix.

const MCP_NAME_PREFIX: &str = "mcp__";
const MCP_NAME_SEPARATOR: &str = "__";
const MAX_QUALIFIED_LENGTH: usize = 64;

/// Sanitize one name part: non `[a-zA-Z0-9_-]` → `_`, collapse `_` runs.
pub fn sanitize_name_part(part: &str) -> String {
    let mut result = String::with_capacity(part.len());
    let mut last_underscore = false;
    for character in part.chars() {
        let mapped = if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            character
        } else {
            '_'
        };
        if mapped == '_' {
            if last_underscore {
                continue;
            }
            last_underscore = true;
        } else {
            last_underscore = false;
        }
        result.push(mapped);
    }
    result
}

pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_NAME_PREFIX)
}

/// Build the qualified tool name used inside the agent and on the wire.
pub fn qualify_tool_name(server_name: &str, tool_name: &str) -> String {
    let full = format!(
        "{MCP_NAME_PREFIX}{}{MCP_NAME_SEPARATOR}{}",
        sanitize_name_part(server_name),
        sanitize_name_part(tool_name)
    );
    if full.len() <= MAX_QUALIFIED_LENGTH {
        return full;
    }
    let hash = stable_hash8(&full);
    let head: String = full
        .chars()
        .take(MAX_QUALIFIED_LENGTH - hash.len() - 1)
        .collect();
    format!("{head}_{hash}")
}

/// 32-bit FNV-1a, hex-encoded to 8 chars — collision resistance among a
/// handful of truncated tool names, not a cryptographic hash.
fn stable_hash8(input: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in input.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_and_collapses_underscores() {
        assert_eq!(sanitize_name_part("cua-driver-mcp"), "cua-driver-mcp");
        assert_eq!(sanitize_name_part("my.server"), "my_server");
        assert_eq!(sanitize_name_part("a..b"), "a_b");
        assert_eq!(sanitize_name_part("a  b"), "a_b");
        assert_eq!(sanitize_name_part("工具"), "_");
    }

    #[test]
    fn qualifies_with_prefix_and_separator() {
        let name = qualify_tool_name("cua-driver-mcp", "click");
        assert_eq!(name, "mcp__cua-driver-mcp__click");
        assert!(is_mcp_tool_name(&name));
        assert!(!is_mcp_tool_name("Read"));
    }

    #[test]
    fn truncates_long_names_with_stable_hash() {
        let long_server = "s".repeat(40);
        let long_tool = "t".repeat(40);
        let name = qualify_tool_name(&long_server, &long_tool);
        assert!(name.len() <= MAX_QUALIFIED_LENGTH, "got len {}", name.len());
        assert!(name.starts_with("mcp__"));
        // Deterministic across calls.
        assert_eq!(name, qualify_tool_name(&long_server, &long_tool));
        // Distinct inputs produce distinct suffixes.
        let other = qualify_tool_name(&long_server, &"u".repeat(40));
        assert_ne!(name, other);
    }

    #[test]
    fn separator_cannot_appear_inside_a_part() {
        // A tool named "a__b" must not collide with server/tool splitting.
        let name = qualify_tool_name("srv", "a__b");
        assert_eq!(name, "mcp__srv__a_b");
        let rest = &name[MCP_NAME_PREFIX.len()..];
        let (server, tool) = rest.split_once(MCP_NAME_SEPARATOR).unwrap();
        assert_eq!(server, "srv");
        assert_eq!(tool, "a_b");
    }
}
