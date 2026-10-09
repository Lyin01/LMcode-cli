//! `ReadMediaFile` — return an image or video as content parts.
//!
//! The TypeScript tool is skipped when the model has neither `image_in` nor
//! `video_in`. This port does the same: [`ReadMediaFileTool::new`] returns
//! `None` in that case. Model capability flags are not in the Rust config
//! yet, so hosts that always want images pass `image_in: true`.

use std::path::Path;

use async_trait::async_trait;
use lmcode_llm::message::{ContentPart, ImageUrl};
use serde_json::{Value, json};

use super::{Tool, ToolResult, resolve_path};

const MAX_MEDIA_BYTES: u64 = 100 * 1024 * 1024;
const SNIFF_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image,
    Video,
    Text,
    Unknown,
}

struct FileType {
    kind: MediaKind,
    mime: &'static str,
}

pub struct ReadMediaFileTool {
    image_in: bool,
    video_in: bool,
    description: String,
}

impl ReadMediaFileTool {
    /// `None` when the model cannot accept images or video. That matches
    /// the TypeScript `SkipThisTool` constructor failure.
    pub fn new(image_in: bool, video_in: bool) -> Option<Self> {
        if !image_in && !video_in {
            return None;
        }
        Some(Self {
            image_in,
            video_in,
            description: build_description(image_in, video_in),
        })
    }
}

fn build_description(image_in: bool, video_in: bool) -> String {
    let mut lines = vec![
        "Read an image or video file and return it to the model.".to_string(),
        "Relative paths resolve against the working directory. Text files are not supported; use Read for those.".to_string(),
    ];
    match (image_in, video_in) {
        (true, true) => {
            lines.push(
                "- This tool supports image and video files for the current model.".to_string(),
            );
        }
        (true, false) => {
            lines.push("- This tool supports image files for the current model.".to_string());
            lines.push("- Video files are not supported by the current model.".to_string());
        }
        (false, true) => {
            lines.push("- This tool supports video files for the current model.".to_string());
            lines.push("- Image files are not supported by the current model.".to_string());
        }
        (false, false) => {}
    }
    lines.join("\n")
}

pub(crate) fn media_size_error(path: &str, len: u64) -> Option<String> {
    if len == 0 {
        Some(format!("\"{path}\" is empty."))
    } else if len > MAX_MEDIA_BYTES {
        Some(format!(
            "\"{path}\" is {len} bytes, which exceeds the maximum 100MB for media files."
        ))
    } else {
        None
    }
}

fn detect_file_type(path: &str, header: &[u8]) -> FileType {
    if header.starts_with(&[0x89, b'P', b'N', b'G']) {
        return FileType {
            kind: MediaKind::Image,
            mime: "image/png",
        };
    }
    if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return FileType {
            kind: MediaKind::Image,
            mime: "image/jpeg",
        };
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return FileType {
            kind: MediaKind::Image,
            mime: "image/gif",
        };
    }
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
        return FileType {
            kind: MediaKind::Image,
            mime: "image/webp",
        };
    }
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        return FileType {
            kind: MediaKind::Video,
            mime: "video/mp4",
        };
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "txt" | "md" | "rs" | "ts" | "js" | "json" | "toml" | "py" | "html" | "css" | "csv"
    ) || (!header.contains(&0) && std::str::from_utf8(header).is_ok())
    {
        return FileType {
            kind: MediaKind::Text,
            mime: "text/plain",
        };
    }
    FileType {
        kind: MediaKind::Unknown,
        mime: "application/octet-stream",
    }
}

fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || &data[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(data[20..24].try_into().ok()?);
    if width == 0 || height == 0 {
        None
    } else {
        Some((width, height))
    }
}

fn system_summary(kind: MediaKind, mime: &str, len: u64, dimensions: Option<(u32, u32)>) -> String {
    let kind_name = match kind {
        MediaKind::Image => "image",
        MediaKind::Video => "video",
        MediaKind::Text | MediaKind::Unknown => "file",
    };
    let mut parts = vec![
        format!("Read {kind_name} file."),
        format!("Mime type: {mime}."),
        format!("Size: {len} bytes."),
    ];
    if kind == MediaKind::Image
        && let Some((width, height)) = dimensions
    {
        parts.push(format!("Original dimensions: {width}x{height} pixels."));
        parts.push(
            "If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size.".to_string(),
        );
    }
    parts.push(
        "If you generate or edit images or videos via commands or scripts, read the result back immediately before continuing.".to_string(),
    );
    format!("<system>{}</system>", parts.join(" "))
}

#[async_trait]
impl Tool for ReadMediaFileTool {
    fn name(&self) -> &str {
        "ReadMediaFile"
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to an image or video file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories and text files are not supported."
                }
            },
            "required": ["path"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    fn declared_file_accesses(&self, arguments: &Value) -> Vec<crate::permission::FileAccess> {
        super::path_access(arguments, "path", crate::permission::FileOperation::Read)
    }

    async fn execute(&self, arguments: &Value, cwd: &Path) -> Result<String, String> {
        let result = self.execute_rich(arguments, cwd).await?;
        if result.ok {
            Ok(result.text)
        } else {
            Err(result.text)
        }
    }

    async fn execute_rich(&self, arguments: &Value, cwd: &Path) -> Result<ToolResult, String> {
        let path = arguments["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or("File path cannot be empty.")?;
        if let Some(message) = crate::permission::sensitive_file_block(path) {
            return Ok(ToolResult::failure(message));
        }
        let resolved = resolve_path(path, cwd);
        let data = match tokio::fs::read(&resolved).await {
            Ok(data) => data,
            Err(error) => {
                return Ok(ToolResult::failure(format!(
                    "Failed to read {path}: {error}"
                )));
            }
        };
        if let Some(message) = media_size_error(path, data.len() as u64) {
            return Ok(ToolResult::failure(message));
        }
        let sniffed = data.len().min(SNIFF_BYTES);
        let file_type = detect_file_type(path, &data[..sniffed]);
        let message = match file_type.kind {
            MediaKind::Text => Some(format!(
                "\"{path}\" is a text file. Use Read to read text files."
            )),
            MediaKind::Unknown => Some(format!(
                "\"{path}\" is not a supported image or video file. Use Read for text files, or Bash or an MCP tool for other binary formats."
            )),
            MediaKind::Image if !self.image_in => Some(
                "The current model does not support image input. Tell the user to use a model with image input capability.".to_string(),
            ),
            MediaKind::Video if !self.video_in => Some(
                "The current model does not support video input. Tell the user to use a model with video input capability.".to_string(),
            ),
            MediaKind::Image | MediaKind::Video => None,
        };
        if let Some(message) = message {
            return Ok(ToolResult::failure(message));
        }
        let dimensions = if file_type.kind == MediaKind::Image {
            png_dimensions(&data)
        } else {
            None
        };
        let summary = system_summary(
            file_type.kind,
            file_type.mime,
            data.len() as u64,
            dimensions,
        );
        let tag = if file_type.kind == MediaKind::Image {
            "image"
        } else {
            "video"
        };
        let shown = resolved.display().to_string();
        let encoded = base64_encode(&data);
        let url = format!("data:{};base64,{encoded}", file_type.mime);
        let media = if file_type.kind == MediaKind::Image {
            ContentPart::ImageUrl {
                image_url: ImageUrl { url, id: None },
            }
        } else {
            ContentPart::VideoUrl {
                video_url: ImageUrl { url, id: None },
            }
        };
        Ok(ToolResult::parts(
            vec![
                ContentPart::Text { text: summary },
                ContentPart::Text {
                    text: format!("<{tag} path=\"{shown}\">"),
                },
                media,
                ContentPart::Text {
                    text: format!("</{tag}>"),
                },
            ],
            true,
        ))
    }
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        let chunk =
            ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8) | data[index + 2] as u32;
        out.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 0x3F) as usize] as char);
        out.push(TABLE[(chunk & 0x3F) as usize] as char);
        index += 3;
    }
    let rest = data.len() - index;
    if rest == 1 {
        let chunk = (data[index] as u32) << 16;
        out.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let chunk = ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8);
        out.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 PNG. IHDR width and height are 1.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x50, 0x0F, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xA9, 0x8C, 0x21, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn skips_construction_without_a_media_capability() {
        assert!(ReadMediaFileTool::new(false, false).is_none());
        let tool = ReadMediaFileTool::new(true, false).unwrap();
        assert_eq!(tool.name(), "ReadMediaFile");
        assert!(tool.description().contains("image files"));
        assert!(tool.description().contains("Video files are not supported"));
        let path = tool.parameters_schema()["properties"]["path"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(path.to_lowercase().contains("working directory"));
        assert!(path.to_lowercase().contains("text file"));
        assert!(!path.starts_with("Absolute path"));
    }

    #[test]
    fn size_guard_names_empty_and_the_100mb_cap() {
        assert!(media_size_error("shot.png", 0).unwrap().contains("empty"));
        let huge = media_size_error("shot.png", MAX_MEDIA_BYTES + 1).unwrap();
        assert!(huge.contains("100MB"), "{huge}");
        assert!(huge.contains(&(MAX_MEDIA_BYTES + 1).to_string()));
    }

    #[tokio::test]
    async fn png_result_carries_the_system_summary_and_an_image_part() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.png");
        tokio::fs::write(&path, PNG_1X1).await.unwrap();
        let tool = ReadMediaFileTool::new(true, false).unwrap();
        let result = tool
            .execute_rich(&json!({"path": "sample.png"}), dir.path())
            .await
            .unwrap();
        assert!(result.ok);
        assert!(result.text.contains("<system>"), "{}", result.text);
        assert!(result.text.contains("image/png"), "{}", result.text);
        assert!(
            result.text.contains(&format!("{} bytes", PNG_1X1.len())),
            "{}",
            result.text
        );
        assert!(result.text.contains("1x1 pixels"), "{}", result.text);
        assert!(
            result.text.contains("relative coordinates first"),
            "{}",
            result.text
        );
        assert!(
            result.text.contains("read the result back"),
            "{}",
            result.text
        );
        assert!(result.text.contains("<image path="), "{}", result.text);
        assert!(result.text.contains("</image>"), "{}", result.text);
        assert!(result.content.iter().any(|part| matches!(
            part,
            ContentPart::ImageUrl { image_url } if image_url.url.starts_with("data:image/png;base64,")
        )));
    }

    #[tokio::test]
    async fn text_and_unknown_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("notes.txt"), "hello")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("blob.bin"), [0, 1, 2, 3, 4])
            .await
            .unwrap();
        let tool = ReadMediaFileTool::new(true, true).unwrap();
        let text = tool
            .execute_rich(&json!({"path": "notes.txt"}), dir.path())
            .await
            .unwrap();
        assert!(!text.ok);
        assert!(text.text.contains("is a text file"));
        assert!(text.text.contains("Use Read"));
        let unknown = tool
            .execute_rich(&json!({"path": "blob.bin"}), dir.path())
            .await
            .unwrap();
        assert!(!unknown.ok);
        assert!(unknown.text.contains("not a supported image or video file"));
        assert!(!unknown.text.contains("Python tools"));
    }

    #[tokio::test]
    async fn video_without_capability_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut header = vec![0, 0, 0, 0x18];
        header.extend_from_slice(b"ftypisom");
        header.extend_from_slice(&[0, 0, 0, 0]);
        tokio::fs::write(dir.path().join("clip.mp4"), &header)
            .await
            .unwrap();
        let tool = ReadMediaFileTool::new(true, false).unwrap();
        let result = tool
            .execute_rich(&json!({"path": "clip.mp4"}), dir.path())
            .await
            .unwrap();
        assert!(!result.ok);
        assert!(
            result.text.to_lowercase().contains("video input"),
            "{}",
            result.text
        );
    }
}
