//! Cross-session memory store — Rust port of `packages/memory`.
//!
//! Stores structured task-experience memos in the same SQLite database the
//! TypeScript implementation uses (`~/.lmcode/memory/memos.sqlite`), with a
//! compatible schema so both implementations can read each other's memos.
//! Ranking is keyword-based (Jaccard) with recency, project, and tag factors;
//! dream consolidation (near-duplicate merging) is implemented as well.

pub mod consolidator;
pub mod dream;
pub mod embeddings;
pub mod error;
pub mod extractor;
pub mod memo;
pub mod scoring;
pub mod store;
pub mod tags;

pub use consolidator::{
    ApplyResult, ConsolidationPlan, DuplicateGroup, MergedMemo, apply_consolidation,
    build_consolidation_plan,
};
pub use dream::{DreamState, DreamTracker};
#[cfg(feature = "local-embeddings")]
pub use embeddings::LocalEmbeddingEngine;
pub use embeddings::{EmbeddingEngine, OpenAiEmbeddingEngine, build_embedding_text};
pub use error::MemoryError;
pub use extractor::{
    EXIT_EXTRACTION_SYSTEM_PROMPT, PendingTaskRef, build_exit_extraction_prompt,
    parse_memory_memos, parse_resolved_pending_ids,
};
pub use memo::{MemoKind, MemoryMemo};
pub use scoring::{ScoredMemo, cosine_similarity, rank_memos};
pub use store::{MemoPatch, MemoStore};
pub use tags::{generate_tags, normalize_tags};
