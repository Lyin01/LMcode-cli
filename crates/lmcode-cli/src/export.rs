//! `lm export` — export a session as a ZIP archive.
//!
//! Mirrors the legacy `apps/lmcode/src/cli/sub/export.ts` contract:
//! with a session id, that session; without one, the most recent session for
//! the current directory (with a TTY confirmation unless `-y`). The archive
//! contains `manifest.json` (same field names as the legacy manifest, plus a
//! `runtime` marker) and the session's files under `session/`.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use lmcode_app_server::write_session_archive;
use lmcode_core::session::SessionStore;

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

    match write_session_archive(
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

/// Default output path helper (kept public for tests).
pub fn default_output_path(cwd: &Path, session_id: &str) -> PathBuf {
    cwd.join(format!("lmcode-session-{session_id}.zip"))
}
