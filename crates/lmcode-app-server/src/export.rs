//! Session ZIP archive shared by `lm export` and `session/export`.

use std::io::{Read, Write};
use std::path::Path;

use lmcode_core::session::{encode_workdir_key, sessions_root};
use lmcode_llm::message::{Message, Role};
use serde_json::json;
use zip::write::SimpleFileOptions;

/// Write the export archive. Session files land under `session/`.
pub fn export_session_archive(
    cwd: &Path,
    session_id: &str,
    messages: &[Message],
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
            if matches!(message.role, Role::User) {
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
