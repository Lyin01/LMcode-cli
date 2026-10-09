//! CLI surface parity tests.
//!
//! `LEGACY_SURFACE` enumerates the option surface of the legacy CLI
//! (`apps/lmcode/src/cli/commands.ts` + `options.ts`): every entry must be
//! present in `lm --help`, and every conflict the legacy `validateOptions`
//! rejects must fail fast with a non-zero exit code before any provider or
//! config setup happens.

use std::process::Command;

fn lm() -> Command {
    Command::new(env!("CARGO_BIN_EXE_lm"))
}

/// Options, aliases, and positional forms the legacy CLI accepts.
const LEGACY_SURFACE: &[&str] = &[
    "[PROMPT]...",                     // positional one-shot prompt
    "-p, --prompt [<PROMPT>]",         // non-interactive prompt (optional value)
    "-m, --model <MODEL>",             // model alias
    "-y, --yolo",                      // approve everything
    "--auto",                          // auto permission mode
    "-C, --continue",                  // continue last session
    "-c",                              // -C alias
    "-S, --session",                   // resume by id / pick latest
    "-r, --resume",                    // -S alias
    "--plan",                          // start in plan mode
    "--skills-dir <DIR>",              // explicit skills directories
    "--output-format <OUTPUT_FORMAT>", // text | stream-json
    "export",                          // export sub-command
    "channel",                         // cc-connect channel sub-command
    "-h, --help",                      // help
    "-V, --version",                   // version
];

#[test]
fn help_lists_the_legacy_surface() {
    let output = lm().arg("--help").output().expect("run lm --help");
    assert!(output.status.success(), "--help must exit 0");
    let help = String::from_utf8_lossy(&output.stdout);
    for needle in LEGACY_SURFACE {
        assert!(help.contains(needle), "help is missing `{needle}`:\n{help}");
    }
    // stream-json must be an accepted --output-format value.
    assert!(
        help.contains("stream-json"),
        "help is missing the stream-json format value:\n{help}"
    );
}

/// Sub-command surfaces mirror the legacy commander commands.
#[test]
fn subcommands_match_the_legacy_surface() {
    let export_help = lm()
        .args(["export", "--help"])
        .output()
        .expect("run lm export --help");
    assert!(export_help.status.success());
    let export_help = String::from_utf8_lossy(&export_help.stdout);
    for needle in [
        "[SESSION_ID]",
        "-o, --output <PATH>",
        "-y, --yes",
        "--no-include-global-log",
    ] {
        assert!(
            export_help.contains(needle),
            "export help is missing `{needle}`:\n{export_help}"
        );
    }

    let channel_help = lm()
        .args(["channel", "--help"])
        .output()
        .expect("run lm channel --help");
    assert!(channel_help.status.success());
    let channel_help = String::from_utf8_lossy(&channel_help.stdout);
    assert!(
        channel_help.contains("setup"),
        "channel help is missing the setup action:\n{channel_help}"
    );

    // Hidden cc-connect protocol sub-command: all flags cc-connect passes
    // must be accepted.
    let stream_help = lm()
        .args(["stream-json", "--help"])
        .output()
        .expect("run lm stream-json --help");
    assert!(stream_help.status.success());
    let stream_help = String::from_utf8_lossy(&stream_help.stdout);
    for needle in [
        "--input-format",
        "--output-format",
        "--resume",
        "--model",
        "--permission-mode",
        "--permission-prompt-tool",
        "--replay-user-messages",
        "--verbose",
        "--system-prompt",
        "--append-system-prompt",
        "--allowedTools",
        "--disallowedTools",
        "--effort",
        "--max-context-tokens",
        "--skills-dir",
    ] {
        assert!(
            stream_help.contains(needle),
            "stream-json help is missing `{needle}`:\n{stream_help}"
        );
    }
}

#[test]
fn version_flag_works() {
    let output = lm().arg("-V").output().expect("run lm -V");
    assert!(output.status.success(), "-V must exit 0");
    let version = String::from_utf8_lossy(&output.stdout);
    assert!(
        version.to_ascii_lowercase().contains("lm"),
        "unexpected version output: {version}"
    );
}

/// The full `--help` text is pinned by a checked-in golden fixture
/// (normalized: the binary name is `lm` on every platform, LF line endings).
#[test]
fn help_matches_golden_fixture() {
    let output = lm().arg("--help").output().expect("run lm --help");
    assert!(output.status.success(), "--help must exit 0");
    let actual = String::from_utf8_lossy(&output.stdout)
        .replace("lm.exe", "lm")
        .replace("\r\n", "\n");
    let golden = include_str!("fixtures/help.golden.txt").replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "`lm --help` drifted from tests/fixtures/help.golden.txt"
    );
}

/// Every conflict the legacy validator rejects must exit non-zero with a
/// clear error, before any config/provider setup runs.
#[test]
fn conflicting_options_are_rejected() {
    let cases: &[&[&str]] = &[
        &["--yolo", "--auto"],
        &["--continue", "--session", "abc"],
        &["--continue", "--resume", "abc"],
        &["-p", ""],
        &["-p", "x", "--plan"],
        &["-p", "x", "-S"],
        &["--output-format", "stream-json"],
        &["-m", "", "-p", "x"],
    ];
    for args in cases {
        let output = lm().args(*args).output().expect("run lm with conflicts");
        assert!(
            !output.status.success(),
            "expected non-zero exit for {args:?}, stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("错误："),
            "expected an `错误：` message for {args:?}, got: {stderr}"
        );
    }
}

/// Headless `-p` runs are documented to force auto approval; a prompt with
/// conflicting session flags must still be rejected (validated above), but
/// `-p` combined with `--yolo` is a tolerated no-op combination.
#[test]
fn prompt_with_yolo_is_accepted_by_the_validator() {
    // We cannot run a full turn without a provider; only assert the process
    // does not fail at the *validation* stage: the error (if any) must not be
    // one of the conflict messages.
    let output = lm()
        .args([
            "-p",
            "x",
            "--yolo",
            "--config",
            "Z:/nonexistent/config.toml",
        ])
        .output()
        .expect("run lm -p with yolo");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("不能与"),
        "valid combination was rejected as a conflict: {stderr}"
    );
}

/// Environment-variable matrix: a hostile/empty LMCODE_HOME must not break
/// trivial invocations (they never read config).
#[test]
fn trivial_invocations_survive_hostile_environment() {
    let cases: &[&[&str]] = &[&["--help"], &["--version"], &["export", "--help"]];
    for lmcode_home in ["Z:/definitely/not/here", ""] {
        for args in cases {
            let output = lm()
                .env("LMCODE_HOME", lmcode_home)
                .args(*args)
                .output()
                .expect("run lm");
            assert!(
                output.status.success(),
                "`lm {args:?}` must work with LMCODE_HOME={lmcode_home:?}"
            );
        }
    }
}

/// Original test vectors from the legacy suite
/// (`apps/lmcode/test/cli/options.test.ts`), executed against the Rust
/// binary: rejection vectors must fail with the legacy message, removed
/// flags must be unknown, and the "passes validation" vectors must not hit
/// any conflict message.
#[test]
fn legacy_option_test_vectors() {
    // Bare `-p` (no text) → prompt mode with an empty prompt → rejected.
    let output = lm().arg("-p").output().expect("run lm -p");
    assert!(!output.status.success(), "bare -p must fail validation");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("提示不能为空。"),
        "bare -p must report 提示不能为空。"
    );

    // `--model "   "` → rejected.
    let output = lm().args(["--model", "   "]).output().expect("run lm");
    assert!(!output.status.success(), "blank model must fail validation");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("模型不能为空。"),
        "blank model must report 模型不能为空。"
    );

    // Removed flags are unknown to the parser (same list as the legacy
    // suite; `--config` is intentionally a Rust-only extension and excluded).
    let removed = [
        "--verbose",
        "--debug",
        "--work-dir=/",
        "--thinking",
        "--print",
        "--wire",
        "--agent=default",
        "--add-dir=/",
        "--raw-model",
        "--config-file=x",
        "--quiet",
        "--final-message-only",
        "--input-format=text",
        "--agent-file=x",
        "--mcp-config={}",
        "--mcp-config-file=/",
    ];
    for flag in removed {
        let output = lm().arg(flag).output().expect("run lm");
        assert!(
            !output.status.success(),
            "removed flag `{flag}` must be rejected"
        );
    }
}

/// Vectors that pass validation: they may fail later (provider setup), but
/// the failure must not be one of the conflict messages.
#[test]
fn legacy_vectors_that_pass_validation() {
    let cases: &[&[&str]] = &[
        &["-p", "continue here", "--continue"],
        &["-p", "resume here", "--session", "ses_123"],
        &["-p", "run this", "--yolo"],
        &["-p", "run this", "--auto"],
        &["--output-format", "stream-json", "explain this repo"],
        &["-p", "--output-format", "stream-json", "explain this repo"],
    ];
    for args in cases {
        let output = lm()
            .args(*args)
            .env("LMCODE_HOME", "Z:/definitely/not/here")
            .output()
            .expect("run lm");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("不能与")
                && !stderr.contains("不能为空")
                && !stderr.contains("仅在提示模式"),
            "vector {args:?} should pass validation, got: {stderr}"
        );
    }
}
