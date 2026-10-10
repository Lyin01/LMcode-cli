# Test Coverage (Rust rewrite)

Measured with `cargo llvm-cov --workspace --all-targets --summary-only`
(cargo-llvm-cov 0.9.1, llvm-tools-preview, rustc 1.99.0 MSVC).

## Summary

| Metric | Covered / Total | % |
|---|---|---|
| Lines | 16901 / 23052 | **73.32%** |
| Functions | 1125 / 1717 | **65.52%** |
| Regions | 10587 / 14737 | **71.84%** |

## Highlights

- `lmcode-memory`: most files 90–100% (embeddings/tags 100%, memo 98.35%,
  scoring 95.91%, consolidator 94.23%).
- `lmcode-mcp`: http.rs 90.59%, naming.rs 98.53%.
- `lmcode-tui`: most files 85–100% (picker 100%, markdown 99.75%,
  commands 98.48%); `bridge.rs` 33.71% — its `TurnUi` forwarding and
  approval round-trip paths are covered by unit tests; the remaining lines
  are the worker spawn loop (needs a live agent).
- `lmcode-tui/src/lib.rs`: 0% — this file is only the interactive
  event-loop entry point (`run()`), which requires a real TTY; it is
  exercised manually via `winpty` sessions instead (see AGENTS.md), not by
  the test suite. Everything it drives (render/markdown/diff/mentions/
  picker/app logic) is unit-tested separately.

## Baseline comparison (legacy TypeScript vs Rust)

Both suites were run on this machine (Node 26, vitest 4):

| Suite | Test files | Tests | Passed | Skipped |
|---|---|---|---|---|
| legacy full monorepo (`pnpm test`) | 536 | 6070 | 6016 | 46 |
| legacy `agent-core` + `apps/lmcode` (the parts the Rust crates replace) | 309 | 3724 | 3705 | 16 |
| Rust workspace (`cargo test --workspace --all-targets`) | 25 targets | **278** | 278 | 0 |

Source size: legacy `agent-core` + `apps/lmcode` = 82,223 TS lines (excl.
tests); Rust workspace = 26,544 lines — the rewrite is ~32% of the legacy
line count (typed/compact Rust, plus documented simplifications).

Test-count context: the legacy suite is fine-grained unit testing (≈45
tests per 1k lines); the Rust rewrite follows a contract-level strategy
(≈10.5 per 1k lines — AGENTS.md: test the externally visible contract).
The Rust side compensates with layers the TS suite does not have:

- `cli_surface.rs` contract tests + checked-in `help.golden.txt`.
- `scripts/parity_check.sh`: 7 conflict cases compared **byte-for-byte**
  against the live legacy CLI (identical text + exit code 1).
- `bench_harness.rs` (turn-loop floor) and measured startup comparison
  (Rust 15 ms vs legacy 122 ms).
- Per-batch real-run verification throughout the rewrite (CDP-driven
  desktop runs, winpty TUI sessions, live HTTP/SSE remote-panel checks,
  real MCP/grader/worktree runs) — see AGENTS.md history notes.

Legacy had no checked-in coverage baseline, so `docs/COVERAGE.md` numbers
are the Rust-side baseline for future changes.

Reproduce with:

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov --locked
cargo llvm-cov --workspace --all-targets --summary-only
```
