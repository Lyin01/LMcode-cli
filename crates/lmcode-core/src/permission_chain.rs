//! Permission decision chain.
//!
//! First matching policy wins. Order matches
//! `packages/agent-core/src/agent/permission/policies/index.ts`, except
//! `PreToolCallHook`, which is a user hook and stays out of this chain.
//!
//! `decide` is pure: no process spawn, no approval prompt. The turn loop
//! turns `Ask` into the UI prompt and `Deny` into a tool error.

use crate::config::{
    FileSandboxMode, PermissionMode, RuleDecision, RuleScope, StoredPermissionRule,
};
use crate::permission::{FileAccess, is_sensitive_file};

const DEFAULT_APPROVE_TOOLS: &[&str] = &[
    "Read",
    "Grep",
    "Glob",
    "ReadMediaFile",
    "SetTodoList",
    "TodoList",
    "TaskList",
    "TaskOutput",
    "CronList",
    "WebSearch",
    "FetchURL",
    "Agent",
    "AskUserQuestion",
    "Skill",
    "WolfPack",
    "CreateGoal",
    "UpdateGoal",
    "GetGoal",
    "SetGoalBudget",
    "WriteGoalNote",
];

/// What the chain tells the turn loop to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOutcome {
    Approve,
    Deny,
    Ask,
}

/// Observable result of one tool call. `message` is set on deny.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionDecision {
    pub kind: PermissionOutcome,
    pub message: Option<String>,
}

impl PermissionDecision {
    fn approve() -> Self {
        Self {
            kind: PermissionOutcome::Approve,
            message: None,
        }
    }

    fn deny(message: impl Into<String>) -> Self {
        Self {
            kind: PermissionOutcome::Deny,
            message: Some(message.into()),
        }
    }

    fn ask() -> Self {
        Self {
            kind: PermissionOutcome::Ask,
            message: None,
        }
    }
}

/// One tool call, already reduced to the facts the policies read.
pub struct PermissionRequest<'a> {
    pub tool_name: &'a str,
    pub accesses: &'a [FileAccess],
    /// Bash and WolfPack: no write path can be proven, so workspace-write denies them.
    pub unrestricted: bool,
    /// The tool's own `requires_approval() == false`. Same stage as the default-approve list.
    pub declares_no_approval: bool,
    /// Identical call already approved earlier in this session.
    pub session_approved: bool,
    /// Tool-supplied argument matcher. Absent matchers still match by tool name.
    pub matches_rule: Option<&'a dyn Fn(&str) -> bool>,
}

/// Session posture. Owned so the turn loop can build it from the agent.
#[derive(Debug, Clone)]
pub struct PermissionState {
    pub mode: PermissionMode,
    pub sandbox: FileSandboxMode,
    pub cwd: String,
    pub rules: Vec<StoredPermissionRule>,
    pub session_patterns: Vec<String>,
    pub plan_active: bool,
    pub plan_file: Option<String>,
    pub wolfpack_active: bool,
    /// Non-empty plan body presented by ExitPlanMode. Asks before session history.
    pub plan_review: Option<String>,
    pub subagent: bool,
    pub windows_paths: bool,
    pub inside_git_work_tree: bool,
}

impl Default for PermissionState {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Manual,
            sandbox: FileSandboxMode::FullAccess,
            cwd: String::new(),
            rules: Vec::new(),
            session_patterns: Vec::new(),
            plan_active: false,
            plan_file: None,
            wolfpack_active: false,
            plan_review: None,
            subagent: false,
            windows_paths: false,
            inside_git_work_tree: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPattern {
    pub tool_name: String,
    pub arg_pattern: Option<String>,
}

/// DSL parser for `Bash(rm *)` / `Read` / `mcp__github__*`.
pub fn parse_pattern(pattern: &str) -> Result<ParsedPattern, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("permission pattern: empty string".to_string());
    }
    let Some(open) = trimmed.find('(') else {
        return Ok(ParsedPattern {
            tool_name: trimmed.to_string(),
            arg_pattern: None,
        });
    };
    if !trimmed.ends_with(')') {
        return Err(format!(
            "permission pattern: missing closing paren in \"{pattern}\""
        ));
    }
    let tool_name = &trimmed[..open];
    if tool_name.is_empty() {
        return Err(format!(
            "permission pattern: empty tool name in \"{pattern}\""
        ));
    }
    let arg = &trimmed[open + 1..trimmed.len() - 1];
    if arg.is_empty() {
        return Ok(ParsedPattern {
            tool_name: tool_name.to_string(),
            arg_pattern: None,
        });
    }
    Ok(ParsedPattern {
        tool_name: tool_name.to_string(),
        arg_pattern: Some(arg.to_string()),
    })
}

/// Run the policy chain. The first decisive policy wins.
pub fn decide(request: &PermissionRequest<'_>, state: &PermissionState) -> PermissionDecision {
    if state.mode == PermissionMode::Auto && request.tool_name == "AskUserQuestion" {
        return PermissionDecision::deny(
            "AskUserQuestion is disabled while auto permission mode is active. \
             Make a reasonable decision and continue without asking the user.",
        );
    }
    if let Some(decision) = plan_mode_guard(request, state) {
        return decision;
    }
    if let Some(decision) = user_rule(request, state, RuleDecision::Deny) {
        return decision;
    }
    if let Some(decision) = file_sandbox(request, state) {
        return decision;
    }
    if state.mode != PermissionMode::Yolo {
        if let Some(decision) = sensitive_file_ask(request) {
            return decision;
        }
        if let Some(decision) = git_control_ask(request) {
            return decision;
        }
        if let Some(decision) = cwd_outside_write_ask(request, state) {
            return decision;
        }
    }
    if state.mode == PermissionMode::Auto {
        return PermissionDecision::approve();
    }
    if let Some(decision) = exit_plan_review_ask(request, state) {
        return decision;
    }
    if request.session_approved || session_pattern_matches(request, state) {
        return PermissionDecision::approve();
    }
    if let Some(decision) = user_rule(request, state, RuleDecision::Ask) {
        return decision;
    }
    if let Some(decision) = user_rule(request, state, RuleDecision::Allow) {
        return decision;
    }
    if let Some(decision) = plan_mode_tool_approve(request, state) {
        return decision;
    }
    if state.mode == PermissionMode::Yolo {
        return PermissionDecision::approve();
    }
    if state.wolfpack_active {
        return PermissionDecision::approve();
    }
    if DEFAULT_APPROVE_TOOLS.contains(&request.tool_name) || request.declares_no_approval {
        return PermissionDecision::approve();
    }
    if let Some(decision) = git_cwd_write_approve(request, state) {
        return decision;
    }
    PermissionDecision::ask()
}

fn plan_mode_guard(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if !state.plan_active {
        return None;
    }
    let writes = write_accesses(request);
    if !writes.is_empty() {
        let plan_file = state.plan_file.as_deref();
        let only_plan = plan_file.is_some_and(|plan| {
            writes
                .iter()
                .all(|access| paths_equal(&access.path, plan, state))
        });
        if !only_plan {
            let shown = plan_file.unwrap_or("(no plan file selected yet)");
            return Some(PermissionDecision::deny(format!(
                "Plan mode is active. You may only write to the current plan file: {shown}. \
                 Call ExitPlanMode to exit plan mode before editing other files."
            )));
        }
    }
    if request.tool_name == "TaskStop" {
        return Some(PermissionDecision::deny(
            "TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode \
             before stopping a background task.",
        ));
    }
    if request.tool_name == "CronCreate" || request.tool_name == "CronDelete" {
        return Some(PermissionDecision::deny(format!(
            "{} is not available in plan mode because it would mutate scheduled work that \
             runs after plan exit. Call ExitPlanMode first.",
            request.tool_name
        )));
    }
    None
}

fn file_sandbox(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if state.sandbox == FileSandboxMode::FullAccess {
        return None;
    }
    let writes = write_accesses(request);
    if writes.is_empty() && !request.unrestricted {
        return None;
    }
    if state.sandbox == FileSandboxMode::ReadOnly {
        return Some(PermissionDecision::deny(
            "File writes are disabled by the read-only file sandbox.",
        ));
    }
    if request.unrestricted {
        return Some(PermissionDecision::deny(
            "Unrestricted tools cannot be proven to stay inside the workspace under the \
             workspace-write file sandbox.",
        ));
    }
    if state.cwd.is_empty() {
        return None;
    }
    let outside = writes.iter().any(|access| {
        !is_within_directory(
            &resolve_against(&access.path, &state.cwd),
            &state.cwd,
            state.windows_paths,
        )
    });
    if outside {
        return Some(PermissionDecision::deny(
            "File writes outside the workspace are disabled by the workspace-write file sandbox.",
        ));
    }
    None
}

fn sensitive_file_ask(request: &PermissionRequest<'_>) -> Option<PermissionDecision> {
    if request
        .accesses
        .iter()
        .any(|access| is_sensitive_file(&access.path))
    {
        return Some(PermissionDecision::ask());
    }
    None
}

fn git_control_ask(request: &PermissionRequest<'_>) -> Option<PermissionDecision> {
    let hit = request.accesses.iter().any(|access| {
        access
            .path
            .replace('\\', "/")
            .split('/')
            .any(|segment| segment.eq_ignore_ascii_case(".git"))
    });
    if hit {
        return Some(PermissionDecision::ask());
    }
    None
}

fn cwd_outside_write_ask(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if state.cwd.is_empty() {
        return None;
    }
    let outside = write_accesses(request).iter().any(|access| {
        !is_within_directory(
            &resolve_against(&access.path, &state.cwd),
            &state.cwd,
            state.windows_paths,
        )
    });
    if outside {
        return Some(PermissionDecision::ask());
    }
    None
}

fn exit_plan_review_ask(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if request.tool_name != "ExitPlanMode" || !state.plan_active {
        return None;
    }
    let review = state.plan_review.as_deref().unwrap_or("").trim();
    if review.is_empty() {
        return None;
    }
    Some(PermissionDecision::ask())
}

fn plan_mode_tool_approve(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if request.tool_name == "EnterPlanMode" {
        return Some(PermissionDecision::approve());
    }
    if (request.tool_name == "Write" || request.tool_name == "Edit")
        && state.plan_active
        && state.plan_file.as_deref().is_some_and(|plan| {
            let writes = write_accesses(request);
            !writes.is_empty()
                && writes
                    .iter()
                    .all(|access| paths_equal(&access.path, plan, state))
        })
    {
        return Some(PermissionDecision::approve());
    }
    if request.tool_name == "ExitPlanMode" {
        let review = state.plan_review.as_deref().unwrap_or("").trim();
        if !state.plan_active || review.is_empty() {
            return Some(PermissionDecision::approve());
        }
    }
    None
}

fn git_cwd_write_approve(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
) -> Option<PermissionDecision> {
    if state.windows_paths || !state.inside_git_work_tree || state.cwd.is_empty() {
        return None;
    }
    if request.tool_name != "Write" && request.tool_name != "Edit" {
        return None;
    }
    let writes = write_accesses(request);
    if writes.is_empty() {
        return None;
    }
    if writes.iter().all(|access| {
        is_within_directory(
            &resolve_against(&access.path, &state.cwd),
            &state.cwd,
            false,
        )
    }) {
        return Some(PermissionDecision::approve());
    }
    None
}

fn user_rule(
    request: &PermissionRequest<'_>,
    state: &PermissionState,
    decision: RuleDecision,
) -> Option<PermissionDecision> {
    let rule = state.rules.iter().find(|rule| {
        matches!(
            rule.scope,
            RuleScope::TurnOverride | RuleScope::Project | RuleScope::User
        ) && rule.decision == decision
            && rule_matches(rule, request)
    })?;
    match decision {
        RuleDecision::Deny => {
            let suffix = rule
                .reason
                .as_deref()
                .filter(|reason| !reason.is_empty())
                .map(|reason| format!(" Reason: {reason}"))
                .unwrap_or_default();
            let message = if state.subagent {
                format!(
                    "Tool \"{}\" was denied.{suffix} Try a different approach — don't retry the \
                     same call, don't attempt to bypass the restriction.",
                    request.tool_name
                )
            } else {
                format!(
                    "Tool \"{}\" was denied by permission rule.{suffix}",
                    request.tool_name
                )
            };
            Some(PermissionDecision::deny(message))
        }
        RuleDecision::Ask => Some(PermissionDecision::ask()),
        RuleDecision::Allow => Some(PermissionDecision::approve()),
    }
}

fn session_pattern_matches(request: &PermissionRequest<'_>, state: &PermissionState) -> bool {
    state.session_patterns.iter().any(|pattern| {
        let rule = StoredPermissionRule {
            decision: RuleDecision::Allow,
            scope: RuleScope::SessionRuntime,
            pattern: pattern.clone(),
            reason: None,
        };
        rule_matches(&rule, request)
    })
}

fn rule_matches(rule: &StoredPermissionRule, request: &PermissionRequest<'_>) -> bool {
    let Ok(parsed) = parse_pattern(&rule.pattern) else {
        return false;
    };
    if parsed.tool_name != "*" && !tool_name_matches(&parsed.tool_name, request.tool_name) {
        return false;
    }
    let Some(arg) = parsed.arg_pattern else {
        return true;
    };
    match request.matches_rule {
        None => true,
        Some(matcher) => matcher(&arg),
    }
}

fn tool_name_matches(pattern: &str, name: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') && !pattern.contains('?') {
        return pattern == name;
    }
    globset::GlobBuilder::new(pattern)
        .literal_separator(false)
        .build()
        .map(|glob| glob.compile_matcher().is_match(name))
        .unwrap_or(false)
}

fn write_accesses<'a>(request: &'a PermissionRequest<'a>) -> Vec<&'a FileAccess> {
    request
        .accesses
        .iter()
        .filter(|access| access.operation.is_write())
        .collect()
}

fn paths_equal(access: &str, plan: &str, state: &PermissionState) -> bool {
    if access == plan {
        return true;
    }
    let left = lexical_normalize(&resolve_against(access, &state.cwd), state.windows_paths);
    let right = lexical_normalize(&resolve_against(plan, &state.cwd), state.windows_paths);
    left == right
}

fn resolve_against(path: &str, cwd: &str) -> String {
    if is_absolute(path) || cwd.is_empty() {
        return path.to_string();
    }
    let cwd = cwd.trim_end_matches(['/', '\\']);
    format!("{cwd}/{path}")
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('\\')
        || (path.len() >= 2 && path.as_bytes()[1] == b':')
}

/// Lexical "inside this directory", including the directory itself.
/// A shared prefix such as `/workspace-evil` is outside `/workspace`.
pub fn is_within_directory(candidate: &str, base: &str, windows: bool) -> bool {
    let candidate = lexical_normalize(candidate, windows);
    let base = lexical_normalize(base, windows);
    if candidate == base {
        return true;
    }
    let prefix = if base.ends_with('/') {
        base
    } else {
        format!("{base}/")
    };
    candidate.starts_with(&prefix)
}

fn lexical_normalize(path: &str, windows: bool) -> String {
    let mut text = path.replace('\\', "/");
    if windows {
        text = text.to_lowercase();
    }
    let drive = text
        .get(..2)
        .filter(|prefix| prefix.as_bytes().get(1) == Some(&b':'))
        .map(str::to_string);
    let absolute = text.starts_with('/');
    let mut parts = Vec::new();
    for (index, part) in text.split('/').enumerate() {
        if part.is_empty() || part == "." {
            continue;
        }
        if index == 0 && drive.as_deref() == Some(part) {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    let joined = parts.join("/");
    if let Some(drive) = drive {
        if joined.is_empty() {
            format!("{drive}/")
        } else {
            format!("{drive}/{joined}")
        }
    } else if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::{FileAccess, FileOperation};

    fn write(path: &str) -> FileAccess {
        FileAccess::new(path, FileOperation::Write)
    }

    fn read(path: &str) -> FileAccess {
        FileAccess::new(path, FileOperation::Read)
    }

    fn request<'a>(
        name: &'a str,
        accesses: &'a [FileAccess],
        unrestricted: bool,
    ) -> PermissionRequest<'a> {
        PermissionRequest {
            tool_name: name,
            accesses,
            unrestricted,
            declares_no_approval: false,
            session_approved: false,
            matches_rule: None,
        }
    }

    fn state(mode: PermissionMode, sandbox: FileSandboxMode) -> PermissionState {
        PermissionState {
            mode,
            sandbox,
            cwd: "/workspace".to_string(),
            ..PermissionState::default()
        }
    }

    #[test]
    fn sandbox_denies_writes_and_unrestricted_tools_even_in_yolo() {
        let outside = [write("/tmp/outside.ts")];
        let inside = [write("/workspace/a.ts")];
        let read_only = state(PermissionMode::Yolo, FileSandboxMode::ReadOnly);
        let workspace = state(PermissionMode::Yolo, FileSandboxMode::WorkspaceWrite);

        let denied = decide(&request("Write", &outside, false), &read_only);
        assert_eq!(denied.kind, PermissionOutcome::Deny);
        assert_eq!(
            denied.message.as_deref(),
            Some("File writes are disabled by the read-only file sandbox.")
        );
        let bash = decide(&request("Bash", &[], true), &read_only);
        assert_eq!(
            bash.message.as_deref(),
            Some("File writes are disabled by the read-only file sandbox.")
        );

        let outside_denied = decide(&request("Write", &outside, false), &workspace);
        assert_eq!(
            outside_denied.message.as_deref(),
            Some(
                "File writes outside the workspace are disabled by the workspace-write file sandbox."
            )
        );
        let unrestricted = decide(&request("Bash", &[], true), &workspace);
        assert_eq!(
            unrestricted.message.as_deref(),
            Some(
                "Unrestricted tools cannot be proven to stay inside the workspace under the workspace-write file sandbox."
            )
        );
        assert_eq!(unrestricted.kind, PermissionOutcome::Deny);

        let allowed = decide(
            &request("Write", &inside, false),
            &state(PermissionMode::Auto, FileSandboxMode::WorkspaceWrite),
        );
        assert_eq!(allowed.kind, PermissionOutcome::Approve);

        let reads = [read("/workspace/a.ts")];
        let read_decision = decide(
            &request("Read", &reads, false),
            &state(PermissionMode::Auto, FileSandboxMode::ReadOnly),
        );
        assert_eq!(read_decision.kind, PermissionOutcome::Approve);

        let mut empty_cwd = state(PermissionMode::Manual, FileSandboxMode::WorkspaceWrite);
        empty_cwd.cwd.clear();
        let skipped = decide(&request("Write", &outside, false), &empty_cwd);
        assert_eq!(skipped.kind, PermissionOutcome::Ask);

        let shared_prefix = [write("/workspace-evil/a.ts")];
        let prefix = decide(&request("Write", &shared_prefix, false), &workspace);
        assert_eq!(prefix.kind, PermissionOutcome::Deny);
    }

    #[test]
    fn full_access_yolo_approves_and_does_not_approve_computer_use_by_default() {
        let outside = [write("/tmp/outside.ts")];
        let yolo = decide(
            &request("Write", &outside, false),
            &state(PermissionMode::Yolo, FileSandboxMode::FullAccess),
        );
        assert_eq!(yolo.kind, PermissionOutcome::Approve);

        let click = decide(
            &request("mcp__cua-driver-mcp__click", &[], false),
            &state(PermissionMode::Manual, FileSandboxMode::FullAccess),
        );
        assert_eq!(click.kind, PermissionOutcome::Ask);
        let click_yolo = decide(
            &request("mcp__cua-driver-mcp__click", &[], false),
            &state(PermissionMode::Yolo, FileSandboxMode::FullAccess),
        );
        assert_eq!(click_yolo.kind, PermissionOutcome::Approve);
    }

    #[test]
    fn chain_order_keeps_deny_sandbox_and_session_grants() {
        let mut denied = state(PermissionMode::Yolo, FileSandboxMode::FullAccess);
        denied.rules.push(StoredPermissionRule {
            decision: RuleDecision::Deny,
            scope: RuleScope::User,
            pattern: "Bash(rm *)".to_string(),
            reason: Some("no rm".to_string()),
        });
        let decision = decide(&request("Bash", &[], true), &denied);
        assert_eq!(
            decision.message.as_deref(),
            Some("Tool \"Bash\" was denied by permission rule. Reason: no rm")
        );

        let mut sub = denied.clone();
        sub.subagent = true;
        let sub_decision = decide(&request("Bash", &[], true), &sub);
        assert_eq!(
            sub_decision.message.as_deref(),
            Some(
                "Tool \"Bash\" was denied. Reason: no rm Try a different approach — don't retry the same call, don't attempt to bypass the restriction."
            )
        );

        let mut allow_but_sandbox = state(PermissionMode::Yolo, FileSandboxMode::ReadOnly);
        allow_but_sandbox.rules.push(StoredPermissionRule {
            decision: RuleDecision::Allow,
            scope: RuleScope::User,
            pattern: "Write".to_string(),
            reason: None,
        });
        let writes = [write("/workspace/a.ts")];
        let sandbox_wins = decide(&request("Write", &writes, false), &allow_but_sandbox);
        assert_eq!(sandbox_wins.kind, PermissionOutcome::Deny);

        let mut ask_rule = state(PermissionMode::Manual, FileSandboxMode::FullAccess);
        ask_rule.rules.push(StoredPermissionRule {
            decision: RuleDecision::Ask,
            scope: RuleScope::Project,
            pattern: "Read".to_string(),
            reason: None,
        });
        let reads = [read("/workspace/a.ts")];
        let mut granted = request("Read", &reads, false);
        granted.session_approved = true;
        assert_eq!(decide(&granted, &ask_rule).kind, PermissionOutcome::Approve);
        granted.session_approved = false;
        assert_eq!(decide(&granted, &ask_rule).kind, PermissionOutcome::Ask);

        let mut auto = state(PermissionMode::Auto, FileSandboxMode::FullAccess);
        let question = decide(&request("AskUserQuestion", &[], false), &auto);
        assert_eq!(
            question.message.as_deref(),
            Some(
                "AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user."
            )
        );
        auto.rules.push(StoredPermissionRule {
            decision: RuleDecision::Ask,
            scope: RuleScope::User,
            pattern: "Bash".to_string(),
            reason: None,
        });
        assert_eq!(
            decide(&request("Bash", &[], true), &auto).kind,
            PermissionOutcome::Approve
        );
    }

    #[test]
    fn plan_mode_denies_other_writes_and_task_stop_and_approves_the_plan_file() {
        let mut plan = state(PermissionMode::Yolo, FileSandboxMode::FullAccess);
        plan.plan_active = true;
        plan.plan_file = Some("/workspace/plans/p.md".to_string());
        let other = [write("/workspace/src/main.rs")];
        let denied = decide(&request("Write", &other, false), &plan);
        assert_eq!(denied.kind, PermissionOutcome::Deny);
        assert!(
            denied
                .message
                .as_deref()
                .unwrap()
                .contains("Plan mode is active. You may only write to the current plan file: /workspace/plans/p.md.")
        );
        assert!(
            denied
                .message
                .as_deref()
                .unwrap()
                .contains("Call ExitPlanMode")
        );

        let stop = decide(&request("TaskStop", &[], false), &plan);
        assert_eq!(
            stop.message.as_deref(),
            Some(
                "TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task."
            )
        );
        let cron = decide(&request("CronCreate", &[], false), &plan);
        assert!(cron.message.as_deref().unwrap().starts_with(
            "CronCreate is not available in plan mode because it would mutate scheduled work"
        ));

        plan.mode = PermissionMode::Manual;
        let plan_write = [write("/workspace/plans/p.md")];
        assert_eq!(
            decide(&request("Write", &plan_write, false), &plan).kind,
            PermissionOutcome::Approve
        );
        assert_eq!(
            decide(&request("MultiEdit", &plan_write, false), &plan).kind,
            PermissionOutcome::Ask
        );

        plan.plan_review = Some("ship the parser".to_string());
        plan.mode = PermissionMode::Manual;
        let review = decide(&request("ExitPlanMode", &[], false), &plan);
        assert_eq!(review.kind, PermissionOutcome::Ask);
        let mut already = request("ExitPlanMode", &[], false);
        already.session_approved = true;
        assert_eq!(decide(&already, &plan).kind, PermissionOutcome::Ask);
    }

    #[test]
    fn default_approve_list_skips_task_stop_and_multi_edit() {
        let manual = state(PermissionMode::Manual, FileSandboxMode::FullAccess);
        assert_eq!(
            decide(&request("Read", &[read("a.ts")], false), &manual).kind,
            PermissionOutcome::Approve
        );
        assert_eq!(
            decide(&request("TaskStop", &[], false), &manual).kind,
            PermissionOutcome::Ask
        );
        assert_eq!(
            decide(&request("MultiEdit", &[write("a.ts")], false), &manual).kind,
            PermissionOutcome::Ask
        );
        let mut opted_out = request("Echo", &[], false);
        opted_out.declares_no_approval = true;
        assert_eq!(decide(&opted_out, &manual).kind, PermissionOutcome::Approve);

        let env = [read(".env")];
        assert_eq!(
            decide(&request("Read", &env, false), &manual).kind,
            PermissionOutcome::Ask
        );
        assert_eq!(
            decide(
                &request("Read", &env, false),
                &state(PermissionMode::Yolo, FileSandboxMode::FullAccess)
            )
            .kind,
            PermissionOutcome::Approve
        );
        let git = [read("repo/.git/config")];
        assert_eq!(
            decide(&request("Read", &git, false), &manual).kind,
            PermissionOutcome::Ask
        );
    }

    #[test]
    fn posix_git_work_tree_approves_in_cwd_writes() {
        let mut git = state(PermissionMode::Manual, FileSandboxMode::FullAccess);
        git.inside_git_work_tree = true;
        let inside = [write("/workspace/src/main.rs")];
        assert_eq!(
            decide(&request("Write", &inside, false), &git).kind,
            PermissionOutcome::Approve
        );
        git.windows_paths = true;
        assert_eq!(
            decide(&request("Write", &inside, false), &git).kind,
            PermissionOutcome::Ask
        );
    }

    #[test]
    fn argument_matcher_can_reject_a_deny_rule() {
        let mut state = state(PermissionMode::Yolo, FileSandboxMode::FullAccess);
        state.rules.push(StoredPermissionRule {
            decision: RuleDecision::Deny,
            scope: RuleScope::User,
            pattern: "Bash(rm *)".to_string(),
            reason: Some("no rm".to_string()),
        });
        let matcher = |arg: &str| arg == "rm *";
        let mut call = request("Bash", &[], true);
        call.matches_rule = Some(&matcher);
        assert_eq!(decide(&call, &state).kind, PermissionOutcome::Deny);
        let matcher = |arg: &str| arg == "other";
        call.matches_rule = Some(&matcher);
        assert_eq!(decide(&call, &state).kind, PermissionOutcome::Approve);
        assert!(parse_pattern("Bash(rm *").is_err());
    }

    #[test]
    fn wolfpack_approves_after_the_sandbox() {
        let mut wolf = state(PermissionMode::Manual, FileSandboxMode::FullAccess);
        wolf.wolfpack_active = true;
        assert_eq!(
            decide(&request("Bash", &[], true), &wolf).kind,
            PermissionOutcome::Approve
        );
        wolf.sandbox = FileSandboxMode::WorkspaceWrite;
        assert_eq!(
            decide(&request("Bash", &[], true), &wolf).kind,
            PermissionOutcome::Deny
        );
    }
}
