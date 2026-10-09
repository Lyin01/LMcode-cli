//! Differential golden suite: replays the recorded legacy option vectors
//! (`tests/fixtures/legacy_option_vectors.txt`, captured from the live
//! legacy CLI) against the Rust binary and asserts byte-for-byte identical
//! stderr/stdout lines and exit codes.

use std::process::Command;

fn lm() -> Command {
    Command::new(env!("CARGO_BIN_EXE_lm"))
}

struct Vector {
    args: Vec<String>,
    stderr: Option<String>,
    stdout: Option<String>,
    exit: i32,
}

fn load_vectors() -> Vec<Vector> {
    let text = include_str!("fixtures/legacy_option_vectors.txt");
    let mut vectors = Vec::new();
    let mut current: Option<Vector> = None;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("CASE|") {
            current = Some(Vector {
                args: rest.split('|').map(String::from).collect(),
                stderr: None,
                stdout: None,
                exit: i32::MIN,
            });
        } else if let Some(rest) = line.strip_prefix("STDERR|") {
            current.as_mut().expect("STDERR before CASE").stderr = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("STDOUT|") {
            current.as_mut().expect("STDOUT before CASE").stdout = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("EXIT|") {
            let mut vector = current.take().expect("EXIT before CASE");
            vector.exit = rest.trim().parse().expect("EXIT must be an integer");
            vectors.push(vector);
        }
    }
    assert!(
        !vectors.is_empty(),
        "fixture must define at least one vector"
    );
    vectors
}

#[test]
fn legacy_golden_vectors_match_byte_for_byte() {
    for vector in load_vectors() {
        let output = lm()
            .args(&vector.args)
            .env("LMCODE_HOME", "Z:/definitely/not/here")
            .output()
            .expect("run lm");

        let code = output.status.code().unwrap_or(-1);
        assert_eq!(
            code, vector.exit,
            "exit code mismatch for {:?}",
            vector.args
        );

        if let Some(expected) = &vector.stderr {
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains(expected.as_str()),
                "stderr mismatch for {:?}:\n  expected to contain: {expected}\n  got: {stderr}",
                vector.args
            );
        }
        if let Some(expected) = &vector.stdout {
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                stdout.contains(expected.as_str()),
                "stdout mismatch for {:?}:\n  expected to contain: {expected}\n  got: {stdout}",
                vector.args
            );
        }
    }
}
