//! Permission helpers — sensitive-path detection and session approval memory.
//!
//! The decision chain lives in [`crate::permission_chain`]. Sensitive files
//! (`.env`, cloud credentials, SSH private keys) are rejected by the file
//! tools themselves, in every mode including yolo. `.git` paths are not
//! sensitive files; the chain asks about them unless the mode is yolo.

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

/// File access declared by a tool, in the shape the permission chain consumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileAccess {
    pub path: String,
    pub operation: FileOperation,
    pub recursive: bool,
}

/// What a tool said it will do with [`FileAccess::path`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOperation {
    Read,
    Write,
    ReadWrite,
    Search,
}

impl FileOperation {
    pub fn is_write(self) -> bool {
        matches!(self, Self::Write | Self::ReadWrite)
    }
}

impl FileAccess {
    pub fn new(path: impl Into<String>, operation: FileOperation) -> Self {
        Self {
            path: path.into(),
            operation,
            recursive: matches!(operation, FileOperation::Search),
        }
    }
}

/// Tool-layer rejection message. `None` when the path is not a sensitive file.
///
/// Matches `resolvePathAccess` in `tools/policies/path-access.ts`: there is
/// no approval channel for these paths, including yolo.
pub fn sensitive_file_block(path: &str) -> Option<String> {
    if !is_sensitive_file(path) {
        return None;
    }
    Some(format!(
        "\"{path}\" matches a sensitive-file pattern (env / credential / SSH key). \
         Access is blocked to protect secrets."
    ))
}

/// `tools/policies/sensitive.ts` — narrower than [`is_sensitive_path`].
///
/// `.env.example` and public keys are allowed. `.git` is not a sensitive
/// file; git control paths have their own ask policy.
pub fn is_sensitive_file(path: &str) -> bool {
    const BASENAMES: &[&str] = &[".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
    const PREFIXES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
    const DOT_SUFFIXES: &[&str] = &[
        ".bak",
        ".backup",
        ".copy",
        ".disabled",
        ".key",
        ".old",
        ".orig",
        ".pem",
        ".save",
        ".tmp",
    ];
    const EXEMPT: &[&str] = &[".env.example", ".env.sample", ".env.template"];
    const PUBLIC_KEYS: &[&str] = &["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];

    let name = basename(path);
    let name = name.trim_end_matches([' ', '.']);
    let name = name.to_lowercase();
    if EXEMPT.contains(&name.as_str()) || PUBLIC_KEYS.contains(&name.as_str()) {
        return false;
    }
    if BASENAMES.contains(&name.as_str()) || name.starts_with(".env.") {
        return true;
    }
    for prefix in PREFIXES {
        if name.len() > prefix.len() && name.starts_with(prefix) {
            let suffix = &name[prefix.len()..];
            let next = suffix.chars().next().unwrap_or('\0');
            if next == '-' || next == '_' || (next == '.' && DOT_SUFFIXES.contains(&suffix)) {
                return true;
            }
        }
    }
    let comparable = path.replace('\\', "/").to_lowercase();
    for suffix in [".aws/credentials", ".gcp/credentials"] {
        if comparable.ends_with(&format!("/{suffix}"))
            || comparable.contains(&format!("/{suffix}/"))
        {
            return true;
        }
    }
    false
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
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
    fn sensitive_file_block_matches_the_tool_layer_contract() {
        let blocked = sensitive_file_block(".env").unwrap();
        assert!(blocked.contains("sensitive-file pattern"));
        assert!(blocked.contains("Access is blocked to protect secrets."));
        assert!(is_sensitive_file(".env.local"));
        assert!(is_sensitive_file("secrets/id_rsa"));
        assert!(is_sensitive_file("keys/id_ed25519.bak"));
        assert!(is_sensitive_file("C:/Users/me/.aws/credentials"));
        assert!(is_sensitive_file(".env "));
        assert!(!is_sensitive_file(".env.example"));
        assert!(!is_sensitive_file(".env.sample"));
        assert!(!is_sensitive_file("id_rsa.pub"));
        assert!(!is_sensitive_file("credentials.json"));
        assert!(!is_sensitive_file("repo/.git/config"));
        assert!(sensitive_file_block("src/main.rs").is_none());
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
