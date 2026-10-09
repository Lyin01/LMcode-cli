//! `lm export` — export a session as a ZIP archive.
//!
//! Mirrors the legacy `apps/lmcode/src/cli/sub/export.ts` contract:
//! with a session id, that session; without one, the most recent session for
//! the current directory (with a TTY confirmation unless `-y`). The archive
//! contains `manifest.json` (same field names as the legacy manifest, plus a
//! `runtime` marker) and the session's files under `session/`.

use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use lmcode_core::session::{SessionStore, encode_workdir_key, sessions_root};
use serde_json::json;
use zip::write::SimpleFileOptions;

/// Run the `export` sub-command; returns the process exit code.
pub fn run_export(
    session_id: Option<&str>,
    output: Option<&Path>,
    yes: bool,
    no_include_global_log: bool,
) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("error: cannot resolve current directory: {error}");
            return 1;
        }
    };
    let store = SessionStore::new();
    let session = match session_id {
        Some(id) => match store.load(&cwd, id) {
            Ok(session) => session,
            Err(error) => {
                eprintln!("error: cannot load session {id}: {error}");
                return 1;
            }
        },
        None => match store.latest(&cwd) {
            Ok(Some(session)) => session,
            Ok(None) => {
                eprintln!("未找到可导出的历史会话。");
                return 1;
            }
            Err(error) => {
                eprintln!("error: cannot list sessions: {error}");
                return 1;
            }
        },
    };

    // Confirmation for the "most recent session" path, like the legacy CLI —
    // but only when a human is actually at the terminal.
    if session_id.is_none() && !yes && std::io::stdin().is_terminal() {
        eprint!("导出最近的会话 {}？[y/N] ", session.id());
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("导出已取消。");
            return 0;
        }
    }

    let output_path = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_output_path(&cwd, session.id()));

    match write_archive(
        &cwd,
        session.id(),
        &session.messages,
        &output_path,
        no_include_global_log,
    ) {
        Ok(()) => {
            println!("{}", output_path.display());
            0
        }
        Err(error) => {
            eprintln!("error: export failed: {error}");
            1
        }
    }
}

/// Write the export archive; returns the archive path on success.
fn write_archive(
    cwd: &Path,
    session_id: &str,
    messages: &[lmcode_llm::message::Message],
    output_path: &Path,
    no_include_global_log: bool,
) -> Result<(), String> {
    let session_dir = sessions_root()
        .join(encode_workdir_key(cwd))
        .join(session_id);
    if !session_dir.is_dir() {
        return Err(format!(
            "session directory not found: {}",
            session_dir.display()
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let manifest = json!({
        "sessionId": session_id,
        "exportedAt": now,
        "lmcodeVersion": env!("CARGO_PKG_VERSION"),
        "runtime": "rust",
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "title": messages.iter().find_map(|message| {
            if matches!(message.role, lmcode_llm::message::Role::User) {
                let text = message.text();
                if text.trim().is_empty() {
                    None
                } else {
                    Some(
                        text.lines()
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(80)
                            .collect::<String>(),
                    )
                }
            } else {
                None
            }
        }),
        "workspaceDir": cwd.display().to_string(),
        "messageCount": messages.len(),
        "includesGlobalLog": !no_include_global_log,
    });

    let file = std::fs::File::create(output_path)
        .map_err(|error| format!("cannot create {}: {error}", output_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .unwrap_or_default()
            .as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    // Session files (state.json + messages.jsonl) under `session/`.
    let entries = std::fs::read_dir(&session_dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let mut data = Vec::new();
        std::fs::File::open(&path)
            .and_then(|mut file| file.read_to_end(&mut data))
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        zip.start_file(format!("session/{name}"), options)
            .map_err(|error| error.to_string())?;
        zip.write_all(&data).map_err(|error| error.to_string())?;
    }

    // Global diagnostic log, when present and not excluded.
    if !no_include_global_log {
        let log_path = lmcode_core::config::lmcode_home()
            .join("logs")
            .join("lmcode.log");
        if log_path.is_file() {
            let mut data = Vec::new();
            std::fs::File::open(&log_path)
                .and_then(|mut file| file.read_to_end(&mut data))
                .map_err(|error| format!("cannot read {}: {error}", log_path.display()))?;
            zip.start_file("logs/lmcode.log", options)
                .map_err(|error| error.to_string())?;
            zip.write_all(&data).map_err(|error| error.to_string())?;
        }
    }

    zip.finish().map_err(|error| error.to_string())?;
    Ok(())
}

/// Default output path helper (kept public for tests).
pub fn default_output_path(cwd: &Path, session_id: &str) -> PathBuf {
    cwd.join(format!("lmcode-session-{session_id}.zip"))
}
