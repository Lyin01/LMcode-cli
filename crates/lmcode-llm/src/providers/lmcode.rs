//! LMcode API provider (`lmcode`): OpenAI-compatible chat completions with
//! the LMcode-specific wire normalizations from
//! `packages/liumir/src/providers/lmcode.ts`:
//!
//! - `stream_options.include_usage` so usage arrives on the SSE stream;
//! - tool schemas normalised via [`normalize_tool_schema`] (nested property
//!   schemas without `type` are filled in — the LMcode tool validator rejects
//!   some valid JSON Schema shapes otherwise).
//!
//! Video upload (`lmcode-files.ts`) is not ported yet.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::error::LlmError;
use crate::message::{ContentPart, Message};
use crate::provider::{ChatProvider, GenerateOptions, StreamSummary, StreamedMessage};
use crate::tool::Tool;

use super::ProviderConfig;
use super::openai;

/// Streaming provider for the LMcode API.
pub struct LmcodeProvider {
    name: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
}

/// Video upload input (mirrors `VideoUploadInput` in the TS provider).
pub enum VideoUpload {
    /// Local file path; the extension must map to a video MIME type.
    Path(std::path::PathBuf),
    /// In-memory bytes with an explicit `video/*` MIME type.
    Bytes {
        data: Vec<u8>,
        mime_type: String,
        filename: Option<String>,
    },
}

/// MIME → extension table (mirrors `MIME_TO_EXT` in the TS provider).
const MIME_TO_EXT: &[(&str, &str)] = &[
    ("video/mp4", "mp4"),
    ("video/mpeg", "mpeg"),
    ("video/quicktime", "mov"),
    ("video/webm", "webm"),
    ("video/x-matroska", "mkv"),
    ("video/x-msvideo", "avi"),
    ("video/x-flv", "flv"),
    ("video/3gpp", "3gp"),
];

/// Guess a video MIME type from a filename extension (only the types listed
/// in [`MIME_TO_EXT`] are recognised).
fn mime_from_filename(filename: &str) -> Option<&'static str> {
    let (_, extension) = filename.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    MIME_TO_EXT
        .iter()
        .find(|(_, ext)| *ext == extension)
        .map(|(mime, _)| *mime)
}

/// Guess a filename for an upload from a video MIME type.
fn guess_filename(mime_type: &str) -> String {
    let extension = MIME_TO_EXT
        .iter()
        .find(|(mime, _)| *mime == mime_type)
        .map(|(_, ext)| *ext)
        .unwrap_or("bin");
    format!("upload.{extension}")
}

impl LmcodeProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, LlmError> {
        if config.model.trim().is_empty() {
            return Err(LlmError::Config(format!(
                "provider `{}` has no model selected",
                config.name
            )));
        }
        let base_url = config
            .base_url
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| {
                LlmError::Config(format!(
                    "lmcode provider `{}` requires a `base_url`",
                    config.name
                ))
            })?;
        Ok(Self {
            name: config.name,
            model: config.model,
            base_url,
            api_key: config.api_key,
            headers: config.headers,
            client: reqwest::Client::new(),
        })
    }

    /// Upload a video to the LMcode files service and return a `video_url`
    /// content part (`ms://<id>`) ready to embed in a message (mirrors
    /// `uploadVideo` in the TS provider).
    pub async fn upload_video(&self, input: VideoUpload) -> Result<ContentPart, LlmError> {
        let (data, mime_type, filename) = match input {
            VideoUpload::Path(path) => {
                let filename = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string();
                let Some(mime_type) = mime_from_filename(&filename) else {
                    return Err(LlmError::Config(format!(
                        "file extension does not indicate a video type: {filename}"
                    )));
                };
                let data = std::fs::read(&path).map_err(|source| {
                    LlmError::Config(format!("cannot read video `{}`: {source}", path.display()))
                })?;
                (data, mime_type.to_string(), filename)
            }
            VideoUpload::Bytes {
                data,
                mime_type,
                filename,
            } => {
                if !mime_type.starts_with("video/") {
                    return Err(LlmError::Config(format!(
                        "expected a video mime type, got `{mime_type}`"
                    )));
                }
                let filename = filename.unwrap_or_else(|| guess_filename(&mime_type));
                (data, mime_type, filename)
            }
        };

        let part = reqwest::multipart::Part::bytes(data)
            .file_name(filename.clone())
            .mime_str(&mime_type)
            .map_err(|source| {
                LlmError::Config(format!("invalid mime type `{mime_type}`: {source}"))
            })?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("purpose", "video");
        let url = format!("{}/files", self.base_url.trim_end_matches('/'));
        let mut request = self.client.post(&url).multipart(form);
        if let Some(api_key) = self.api_key.as_deref() {
            request = request.bearer_auth(api_key);
        }
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(LlmError::Api {
                status: status.as_u16(),
                message: openai::extract_error_message(&body),
                retry_after_ms: None,
            });
        }
        #[derive(serde::Deserialize)]
        struct FileObject {
            id: String,
        }
        let file: FileObject = response.json().await.map_err(|source| LlmError::Api {
            status: status.as_u16(),
            message: format!("file upload response parse failed: {source}"),
            retry_after_ms: None,
        })?;
        Ok(ContentPart::VideoUrl {
            video_url: crate::message::ImageUrl {
                url: format!("ms://{}", file.id),
                id: Some(file.id),
            },
        })
    }
}

#[async_trait]
impl ChatProvider for LmcodeProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
        options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError> {
        let mut body = openai::build_request_body(&self.model, system_prompt, tools, history);
        body["stream_options"] = json!({ "include_usage": true });
        if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools {
                if let Some(parameters) = tool.pointer_mut("/function/parameters") {
                    *parameters = normalize_tool_schema(parameters.clone());
                }
            }
        }

        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let mut request = self
            .client
            .post(&url)
            .header("accept", "text/event-stream")
            .json(&body);
        if let Some(api_key) = options.api_key.as_deref().or(self.api_key.as_deref()) {
            request = request.bearer_auth(api_key);
        }
        for (name, value) in self.headers.iter().chain(options.headers.iter()) {
            request = request.header(name, value);
        }

        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(LlmError::Api {
                status: status.as_u16(),
                message: openai::extract_error_message(&body),
                retry_after_ms: None,
            });
        }

        let summary = Arc::new(Mutex::new(StreamSummary::default()));
        let parts = openai::build_parts_stream(response, Arc::clone(&summary));
        Ok(StreamedMessage::new(parts, summary))
    }
}

/// Keys that suppress type completion (mirrors `TYPE_COMPLETION_SKIP_KEYS`).
const TYPE_COMPLETION_SKIP_KEYS: &[&str] = &[
    "$ref", "allOf", "anyOf", "else", "if", "not", "oneOf", "then",
];

#[derive(Clone, Copy)]
enum SlotKind {
    Single,
    Array,
    Map,
    SchemaOrArray,
}

/// Child-schema positions the normalizer walks (mirrors `CHILD_SCHEMA_SLOTS`).
const CHILD_SCHEMA_SLOTS: &[(&str, SlotKind)] = &[
    ("$defs", SlotKind::Map),
    ("definitions", SlotKind::Map),
    ("dependencies", SlotKind::Map),
    ("dependentSchemas", SlotKind::Map),
    ("patternProperties", SlotKind::Map),
    ("properties", SlotKind::Map),
    ("additionalItems", SlotKind::Single),
    ("additionalProperties", SlotKind::Single),
    ("contains", SlotKind::Single),
    ("contentSchema", SlotKind::Single),
    ("else", SlotKind::Single),
    ("if", SlotKind::Single),
    ("not", SlotKind::Single),
    ("propertyNames", SlotKind::Single),
    ("then", SlotKind::Single),
    ("unevaluatedItems", SlotKind::Single),
    ("unevaluatedProperties", SlotKind::Single),
    ("allOf", SlotKind::Array),
    ("anyOf", SlotKind::Array),
    ("oneOf", SlotKind::Array),
    ("prefixItems", SlotKind::Array),
    ("items", SlotKind::SchemaOrArray),
];

const OBJECT_STRUCTURE_KEYS: &[&str] = &[
    "dependencies",
    "dependentSchemas",
    "patternProperties",
    "properties",
    "additionalProperties",
    "propertyNames",
    "unevaluatedProperties",
    "dependentRequired",
    "maxProperties",
    "minProperties",
    "required",
];

const ARRAY_STRUCTURE_KEYS: &[&str] = &[
    "additionalItems",
    "contains",
    "unevaluatedItems",
    "prefixItems",
    "items",
    "maxContains",
    "maxItems",
    "minContains",
    "minItems",
    "uniqueItems",
];

const STRING_STRUCTURE_KEYS: &[&str] = &[
    "contentSchema",
    "contentEncoding",
    "contentMediaType",
    "format",
    "maxLength",
    "minLength",
    "pattern",
];

const NUMERIC_STRUCTURE_KEYS: &[&str] = &[
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maximum",
    "minimum",
    "multipleOf",
];

/// Return a deep-cloned JSON Schema with missing `type` fields filled in for
/// LMcode tool compatibility (mirrors `normalizeLmcodeToolSchema`): local
/// `$ref`s are inlined, then nested property schemas without `type` get an
/// inferred one. Deliberately more forgiving than the TS normalizer — a
/// mixed-typed `enum` leaves the schema untouched instead of failing.
pub fn normalize_tool_schema(schema: Value) -> Value {
    let mut result = deref_local_refs(&schema);
    normalize_types(&mut result);
    result
}

fn deref_local_refs(schema: &Value) -> Value {
    let mut visited = HashSet::new();
    let mut result = resolve_node(schema, schema, &mut visited);
    if let Value::Object(map) = &mut result {
        for bucket in ["$defs", "definitions"] {
            let unresolved = map
                .iter()
                .any(|(key, value)| key != bucket && has_unresolved_definition_ref(value, bucket));
            if !unresolved {
                map.remove(bucket);
            }
        }
    }
    result
}

fn resolve_node(node: &Value, root: &Value, visited: &mut HashSet<String>) -> Value {
    match node {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_node(item, root, visited))
                .collect(),
        ),
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref") {
                if is_local_pointer(reference) {
                    if visited.contains(reference) {
                        // Circular reference — keep the `$ref` as-is.
                        return Value::Object(map.clone());
                    }
                    if let Some(resolved) = resolve_pointer(root, reference) {
                        visited.insert(reference.clone());
                        let resolved = resolve_node(resolved, root, visited);
                        visited.remove(reference);
                        if let Value::Object(mut merged) = resolved {
                            // Sibling keywords on the local node win.
                            for (key, value) in map {
                                if key == "$ref" {
                                    continue;
                                }
                                merged.insert(key.clone(), resolve_node(value, root, visited));
                            }
                            return Value::Object(merged);
                        }
                        return resolved;
                    }
                }
                return Value::Object(map.clone());
            }
            let mut resolved = Map::new();
            for (key, value) in map {
                resolved.insert(key.clone(), resolve_node(value, root, visited));
            }
            Value::Object(resolved)
        }
        other => other.clone(),
    }
}

fn is_local_pointer(reference: &str) -> bool {
    reference == "#" || reference.starts_with("#/")
}

fn resolve_pointer<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    if reference == "#" {
        return Some(root);
    }
    let mut current = root;
    for raw in reference.strip_prefix("#/")?.split('/') {
        let part = raw.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&part)?,
            Value::Array(items) => items.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn has_unresolved_definition_ref(node: &Value, bucket: &str) -> bool {
    match node {
        Value::Array(items) => items
            .iter()
            .any(|item| has_unresolved_definition_ref(item, bucket)),
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref")
                && reference.starts_with(&format!("#/{bucket}/"))
            {
                return true;
            }
            map.iter()
                .filter(|(key, _)| key.as_str() != bucket)
                .any(|(_, value)| has_unresolved_definition_ref(value, bucket))
        }
        _ => false,
    }
}

fn normalize_types(node: &mut Value) {
    if !node.is_object() {
        return;
    }
    let should_fill = {
        let map = node.as_object().expect("checked above");
        !map.contains_key("type")
            && !map
                .keys()
                .any(|key| TYPE_COMPLETION_SKIP_KEYS.contains(&key.as_str()))
    };
    if should_fill {
        let inferred = node.as_object().and_then(infer_type);
        if let Some(inferred) = inferred {
            node.as_object_mut()
                .expect("checked above")
                .insert("type".to_string(), Value::String(inferred.to_string()));
        }
    }
    for (key, kind) in CHILD_SCHEMA_SLOTS {
        let Some(child) = node.get_mut(*key) else {
            continue;
        };
        match kind {
            SlotKind::Single => normalize_types(child),
            SlotKind::Array => {
                if let Some(items) = child.as_array_mut() {
                    for item in items {
                        normalize_types(item);
                    }
                }
            }
            SlotKind::Map => {
                if let Some(entries) = child.as_object_mut() {
                    for (_, item) in entries.iter_mut() {
                        normalize_types(item);
                    }
                }
            }
            SlotKind::SchemaOrArray => {
                if let Some(items) = child.as_array_mut() {
                    for item in items {
                        normalize_types(item);
                    }
                } else {
                    normalize_types(child);
                }
            }
        }
    }
}

fn infer_type(map: &Map<String, Value>) -> Option<&'static str> {
    if let Some(Value::Array(values)) = map.get("enum")
        && !values.is_empty()
    {
        return infer_type_from_values(values);
    }
    if let Some(value) = map.get("const") {
        return infer_type_from_values(std::slice::from_ref(value));
    }
    if has_any_key(map, OBJECT_STRUCTURE_KEYS) {
        return Some("object");
    }
    if has_any_key(map, ARRAY_STRUCTURE_KEYS) {
        return Some("array");
    }
    if has_any_key(map, STRING_STRUCTURE_KEYS) {
        return Some("string");
    }
    if has_any_key(map, NUMERIC_STRUCTURE_KEYS) {
        return Some("number");
    }
    Some("string")
}

fn infer_type_from_values(values: &[Value]) -> Option<&'static str> {
    let mut inferred: Vec<&'static str> = Vec::new();
    for value in values {
        let value_type = infer_value_type(value)?;
        if !inferred.contains(&value_type) {
            inferred.push(value_type);
        }
    }
    // `number` absorbs `integer` (mirrors the TS normalization).
    if inferred.contains(&"number") {
        inferred.retain(|kind| *kind != "integer");
    }
    if inferred.len() == 1 {
        return inferred.first().copied();
    }
    None
}

fn infer_value_type(value: &Value) -> Option<&'static str> {
    match value {
        Value::Null => Some("null"),
        Value::Bool(_) => Some("boolean"),
        Value::Number(number) => Some(if number.is_i64() || number.is_u64() {
            "integer"
        } else {
            "number"
        }),
        Value::String(_) => Some("string"),
        Value::Array(_) => Some("array"),
        Value::Object(_) => Some("object"),
    }
}

fn has_any_key(map: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|key| map.contains_key(*key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_missing_types_for_nested_properties() {
        let schema = json!({
            "type": "object",
            "properties": {
                "mode": { "enum": ["fast", "slow"] },
                "count": { "enum": [1, 2, 3] },
                "ratio": { "enum": [0.5] },
                "flags": { "items": { "type": "string" } },
                "nested": { "properties": { "name": {} } },
                "with_format": { "format": "date-time" },
                "any": {}
            }
        });
        let normalized = normalize_tool_schema(schema);
        assert_eq!(normalized["properties"]["mode"]["type"], "string");
        assert_eq!(normalized["properties"]["count"]["type"], "integer");
        assert_eq!(normalized["properties"]["ratio"]["type"], "number");
        assert_eq!(normalized["properties"]["flags"]["type"], "array");
        assert_eq!(normalized["properties"]["nested"]["type"], "object");
        assert_eq!(
            normalized["properties"]["nested"]["properties"]["name"]["type"],
            "string"
        );
        assert_eq!(normalized["properties"]["with_format"]["type"], "string");
        assert_eq!(normalized["properties"]["any"]["type"], "string");
        // The root keeps its declared type untouched.
        assert_eq!(normalized["type"], "object");
    }

    #[test]
    fn respects_existing_types_and_combinator_slots() {
        let schema = json!({
            "properties": {
                "kept": { "type": "boolean" },
                "choice": { "anyOf": [ { "enum": ["a"] }, { "enum": [1] } ] }
            }
        });
        let normalized = normalize_tool_schema(schema);
        assert_eq!(normalized["properties"]["kept"]["type"], "boolean");
        // Combinator nodes are skipped (no type is invented for `choice`).
        assert!(normalized["properties"]["choice"].get("type").is_none());
        assert_eq!(
            normalized["properties"]["choice"]["anyOf"][0]["type"],
            "string"
        );
        assert_eq!(
            normalized["properties"]["choice"]["anyOf"][1]["type"],
            "integer"
        );
    }

    #[test]
    fn inlines_local_refs_and_drops_resolved_definition_buckets() {
        let schema = json!({
            "type": "object",
            "properties": {
                "point": { "$ref": "#/$defs/Point" }
            },
            "$defs": {
                "Point": {
                    "type": "object",
                    "properties": {
                        "x": { "enum": [1] },
                        "y": { "enum": [2] }
                    }
                }
            }
        });
        let normalized = normalize_tool_schema(schema);
        assert!(
            normalized.get("$defs").is_none(),
            "resolved definition buckets should be dropped"
        );
        assert_eq!(normalized["properties"]["point"]["type"], "object");
        assert_eq!(
            normalized["properties"]["point"]["properties"]["x"]["type"],
            "integer"
        );
    }

    #[test]
    fn keeps_cyclic_refs_and_their_definition_bucket() {
        let schema = json!({
            "properties": {
                "node": { "$ref": "#/$defs/Node" }
            },
            "$defs": {
                "Node": {
                    "properties": {
                        "next": { "$ref": "#/$defs/Node" }
                    }
                }
            }
        });
        let normalized = normalize_tool_schema(schema);
        assert!(
            normalized.get("$defs").is_some(),
            "cyclic refs keep the bucket"
        );
        assert_eq!(normalized["properties"]["node"]["type"], "object");
    }

    #[test]
    fn merges_sibling_keywords_with_resolved_ref() {
        let schema = json!({
            "properties": {
                "when": { "$ref": "#/definitions/Stamp", "description": "keep me" }
            },
            "definitions": {
                "Stamp": { "type": "string", "format": "date-time" }
            }
        });
        let normalized = normalize_tool_schema(schema);
        assert!(normalized.get("definitions").is_none());
        assert_eq!(normalized["properties"]["when"]["type"], "string");
        assert_eq!(normalized["properties"]["when"]["description"], "keep me");
    }

    #[test]
    fn mixed_enum_types_leave_the_schema_untouched() {
        let schema = json!({ "properties": { "odd": { "enum": [1, "a"] } } });
        let normalized = normalize_tool_schema(schema);
        assert!(normalized["properties"]["odd"].get("type").is_none());
    }

    #[test]
    fn infers_video_mime_types() {
        assert_eq!(mime_from_filename("clip.mp4"), Some("video/mp4"));
        assert_eq!(mime_from_filename("CLIP.MOV"), Some("video/quicktime"));
        // Only the extensions in the table are recognised (`mpg` is not).
        assert_eq!(mime_from_filename("clip.mpg"), None);
        assert_eq!(mime_from_filename("notes.txt"), None);
        assert_eq!(mime_from_filename("no-extension"), None);
        assert_eq!(guess_filename("video/webm"), "upload.webm");
        assert_eq!(guess_filename("video/unknown-type"), "upload.bin");
    }
}
