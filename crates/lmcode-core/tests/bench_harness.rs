//! Local performance harness for the agent turn loop.
//!
//! Legacy-vs-Rust throughput parity cannot be asserted automatically: the
//! legacy stack needs a Node runtime plus live provider credentials, and LLM
//! sampling is nondeterministic, so wall-clock comparisons are not
//! reproducible. Instead this harness pins a reproducible *floor* for the
//! Rust turn loop against a scripted provider.
//!
//! Run with:
//! `cargo test -p lmcode-core --release --test bench_harness -- --nocapture`

use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use lmcode_core::agent::{Agent, TurnUi};
use lmcode_llm::LlmError;
use lmcode_llm::message::{ContentPart, Message, StreamedMessagePart};
use lmcode_llm::provider::{
    BoxStream, ChatProvider, FinishReason, GenerateOptions, StreamSummary, StreamedMessage,
};
use lmcode_llm::tool::Tool as ToolDefinition;

/// Answers every `generate` with one short text part and a Completed finish.
struct ScriptedProvider;

#[async_trait]
impl ChatProvider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    fn model_name(&self) -> &str {
        "scripted-model"
    }

    async fn generate(
        &self,
        _system_prompt: &str,
        _tools: &[ToolDefinition],
        _history: &[Message],
        _options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError> {
        let parts = vec![StreamedMessagePart::Content(ContentPart::Text {
            text: "ok".to_string(),
        })];
        let stream: BoxStream<Result<StreamedMessagePart, LlmError>> =
            Box::pin(futures_util::stream::iter(parts.into_iter().map(Ok)));
        let summary = StreamSummary {
            finish_reason: Some(FinishReason::Completed),
            ..StreamSummary::default()
        };
        Ok(StreamedMessage::new(stream, Arc::new(Mutex::new(summary))))
    }
}

/// Counts deltas; ignores everything else.
struct CountingUi {
    deltas: usize,
}

#[async_trait]
impl TurnUi for CountingUi {
    async fn text_delta(&mut self, _text: &str) {
        self.deltas += 1;
    }

    async fn think_delta(&mut self, _text: &str) {}

    async fn tool_start(&mut self, _name: &str, _arguments: &str) {}

    async fn tool_end(&mut self, _name: &str, _ok: bool, _result: &str) {}

    async fn approve(&mut self, _name: &str, _arguments: &str) -> bool {
        true
    }

    async fn notice(&mut self, _message: &str) {}
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_loop_throughput_floor() {
    const TURNS: usize = 500;
    let cwd = std::env::temp_dir();
    let mut agent = Agent::new(
        Arc::new(ScriptedProvider),
        Vec::new(),
        "bench".to_string(),
        cwd,
    );

    let start = Instant::now();
    let mut ui = CountingUi { deltas: 0 };
    for _ in 0..TURNS {
        agent.run_turn("bench", &mut ui).await.expect("turn");
    }
    let elapsed = start.elapsed();
    let per_turn = elapsed.as_secs_f64() / TURNS as f64;
    let turns_per_sec = 1.0 / per_turn;
    println!(
        "bench: {TURNS} scripted turns in {elapsed:?} \
         ({turns_per_sec:.1} turns/sec, {:.1} µs/turn, {} deltas)",
        per_turn * 1e6,
        ui.deltas
    );
    assert_eq!(ui.deltas, TURNS, "every turn must stream its text delta");
    // Generous floor: the scripted loop is pure in-process work; anything
    // slower than 20 ms/turn on a dev machine indicates a regression.
    assert!(
        per_turn < 0.020,
        "turn loop regression: {:.3} ms/turn (floor: 20 ms/turn)",
        per_turn * 1e3
    );
}
