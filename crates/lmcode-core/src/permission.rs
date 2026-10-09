//! Permission helpers — sensitive-path detection and session approval memory.
//!
//! Mirrors the hard-boundary idea of `agent/permission/policies/file-access-ask.ts`:
//! sensitive paths always require confirmation even when the tool itself is
//! auto-approved. `--yolo` (auto-approve) still bypasses everything, matching
//! the TS yolo policy.

use std::collections::HashSet;

/// Sensitive file names that always require confirmation.
const SENSITIVE_NAMES: &[&str] = &[
    ".npmrc",
    ".netrc",
    ".pgpass",
    "credentials",
    "id_rsa",
    "id_ed25519",
];

/// Whether a path refers to a sensitive file (credentials, keys, VCS metadata).
pub fn is_sensitive_path(path: &str) -> bool {
    let normalized = path.to_lowercase().replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);

    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    if SENSITIVE_NAMES.contains(&name) {
        return true;
    }
    if name.starts_with("id_rsa.") || name.starts_with("id_ed25519.") {
        return true;
    }
    if name.ends_with(".pem") || name.ends_with(".key") {
        return true;
    }
    // Git control paths (any `.git` path segment).
    if normalized.split('/').any(|segment| segment == ".git") {
        return true;
    }
    false
}

/// Whether a tool call's arguments point at a sensitive path (checked for the
/// common path-parameter names used across the tool set).
pub fn call_touches_sensitive_path(arguments: &serde_json::Value) -> bool {
    for key in ["path", "file_path", "filePath"] {
        if let Some(path) = arguments.get(key).and_then(|value| value.as_str())
            && is_sensitive_path(path)
        {
            return true;
        }
    }
    false
}

/// Remembers tool calls the user approved during this session so identical
/// calls are not re-prompted (mirrors `session-approval-history.ts`).
#[derive(Debug, Default)]
pub struct SessionApprovals {
    approved: HashSet<String>,
}

impl SessionApprovals {
    pub fn is_approved(&self, tool_name: &str, arguments: &str) -> bool {
        self.approved.contains(&approval_key(tool_name, arguments))
    }

    pub fn record(&mut self, tool_name: &str, arguments: &str) {
        self.approved.insert(approval_key(tool_name, arguments));
    }

    pub fn clear(&mut self) {
        self.approved.clear();
    }
}

fn approval_key(tool_name: &str, arguments: &str) -> String {
    format!("{tool_name}:{:016x}", fnv1a(arguments))
}

fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_sensitive_paths() {
        for path in [
            ".env",
            ".env.local",
            "config/.env.production",
            "secrets/id_rsa",
            "keys/server.pem",
            "certs/tls.key",
            ".git/config",
            "repo/.git/hooks/pre-commit",
            "/home/user/.npmrc",
            "C:\\Users\\me\\.netrc",
        ] {
            assert!(is_sensitive_path(path), "expected sensitive: {path}");
        }
    }

    #[test]
    fn allows_ordinary_paths() {
        for path in [
            "src/main.rs",
            "README.md",
            ".gitignore",
            "env.rs",
            "keynote.md",
            "target/.gitkeep",
        ] {
            assert!(!is_sensitive_path(path), "expected safe: {path}");
        }
    }

    #[test]
    fn detects_sensitive_arguments() {
        assert!(call_touches_sensitive_path(
            &serde_json::json!({"path": ".env"})
        ));
        assert!(call_touches_sensitive_path(
            &serde_json::json!({"file_path": "deploy/id_rsa"})
        ));
        assert!(!call_touches_sensitive_path(
            &serde_json::json!({"path": "src/lib.rs"})
        ));
        assert!(!call_touches_sensitive_path(
            &serde_json::json!({"command": "echo .env"})
        ));
    }

    #[test]
    fn session_approvals_memoize_by_tool_and_arguments() {
        let mut approvals = SessionApprovals::default();
        assert!(!approvals.is_approved("Bash", "{\"command\":\"ls\"}"));
        approvals.record("Bash", "{\"command\":\"ls\"}");
        assert!(approvals.is_approved("Bash", "{\"command\":\"ls\"}"));
        assert!(!approvals.is_approved("Bash", "{\"command\":\"rm -rf /\"}"));
        assert!(!approvals.is_approved("Read", "{\"command\":\"ls\"}"));
        approvals.clear();
        assert!(!approvals.is_approved("Bash", "{\"command\":\"ls\"}"));
    }
}
