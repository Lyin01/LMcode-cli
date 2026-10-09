//! End-to-end tests for the `lm` binary: the real executable drives a full
//! turn against a local mock of the OpenAI-compatible API, plus negative
//! input cases (missing / malformed config, unknown provider).

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Spawn a one-shot mock server that answers a chat-completions request
/// with an SSE stream containing `reply`. Returns its base URL.
///
/// The full request (headers + body) is drained before responding so the
/// socket closes with a clean FIN instead of a Windows RST.
fn spawn_mock_llm(reply: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let reply = reply.to_string();
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = socket.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(headers_end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers_end = headers_end + 4;
                let headers = String::from_utf8_lossy(&buffer[..headers_end]).to_ascii_lowercase();
                let content_length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buffer.len().saturating_sub(headers_end) >= content_length {
                    break;
                }
            }
        }
        let body = format!(
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{reply}\"}},\"finish_reason\":null}}]}}\n\n\
             data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\n\
             data: [DONE]\n\n"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes());
        let _ = socket.flush();
        let _ = socket.shutdown(Shutdown::Write);
    });
    format!("http://{addr}")
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lmcode-cli-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_config(dir: &Path, contents: &str) -> PathBuf {
    let config = dir.join("config.toml");
    std::fs::write(&config, contents).unwrap();
    config
}

fn run_lm(dir: &Path, config: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_lm"))
        .arg("--config")
        .arg(config)
        .args(args)
        .current_dir(dir)
        .env("LMCODE_HOME", dir.join("home"))
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn runs_a_full_turn_against_a_mock_provider() {
    let base_url = spawn_mock_llm("hello-from-mock");
    let dir = temp_dir("turn");
    let config = write_config(
        &dir,
        &format!(
            "default_model = \"mock/m\"\n\n[providers.mock]\ntype = \"openai\"\nbase_url = \"{base_url}\"\napi_key = \"test-key\"\n"
        ),
    );
    let output = run_lm(&dir, &config, &["--yolo", "-p", "hi"]);
    assert!(
        output.status.success(),
        "exit: {:?}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("hello-from-mock"),
        "assistant reply missing from stdout:\n{stdout}"
    );
    // The turn is persisted as a session.
    let sessions = dir.join("home").join("rust-sessions");
    assert!(sessions.exists(), "session directory should exist");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_config_exits_nonzero_with_a_clear_error() {
    let dir = temp_dir("missing");
    let missing = dir.join("does-not-exist.toml");
    let output = run_lm(&dir, &missing, &["-p", "hi"]);
    assert!(!output.status.success(), "missing config must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to read config"),
        "stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn malformed_config_exits_nonzero() {
    let dir = temp_dir("malformed");
    let config = write_config(&dir, "this is not = valid [[ toml");
    let output = run_lm(&dir, &config, &["-p", "hi"]);
    assert!(!output.status.success(), "malformed config must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("config"), "stderr:\n{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_provider_exits_nonzero() {
    let dir = temp_dir("unknown-provider");
    let config = write_config(&dir, "default_model = \"ghost/m\"\n");
    let output = run_lm(&dir, &config, &["-p", "hi"]);
    assert!(!output.status.success(), "unknown provider must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no provider for model"),
        "stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn help_lists_the_core_flags() {
    let dir = temp_dir("help");
    let config = write_config(&dir, "default_model = \"mock/m\"\n");
    let output = run_lm(&dir, &config, &["--help"]);
    assert!(output.status.success(), "--help must exit 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    for flag in ["--tui", "--config", "-p", "--yolo"] {
        assert!(stdout.contains(flag), "missing `{flag}` in:\n{stdout}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_flags_exit_nonzero_with_a_clear_error() {
    let dir = temp_dir("unknown-flag");
    let config = write_config(&dir, "default_model = \"mock/m\"\n");
    let output = run_lm(&dir, &config, &["--definitely-not-a-flag"]);
    assert!(!output.status.success(), "unknown flags must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unexpected argument") || stderr.contains("error"),
        "stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
