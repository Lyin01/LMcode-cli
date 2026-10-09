//! Tool wire schema handed to the model.

use serde::{Deserialize, Serialize};

/// A tool definition: name, description, and JSON-Schema parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema describing the tool arguments.
    pub parameters: serde_json::Value,
}
