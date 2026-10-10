# Test Migration Map: legacy TS suite → Rust workspace

The legacy suite (`packages/agent-core` + `apps/lmcode`, 309 test files /
3,724 tests) targets the *internal* structure of the TypeScript
implementation. The Rust rewrite is an independent implementation with
different internals, so tests are migrated at **module granularity**: each
legacy test directory maps to the Rust module that now owns the behaviour,
plus the verification layer that covers it (unit tests, contract tests, or
recorded real-run verification).

Legend: **U** = Rust unit/integration tests, **C** = contract tests
(`cli_surface.rs`, golden fixtures), **R** = recorded real-run verification
(CDP desktop runs, winpty TUI sessions, live HTTP/SSE, real MCP/grader
runs — see AGENTS.md), **S** = documented simplification/omission.

## agent-core (the parts the Rust crates replace)

| Legacy test dir | Files | Rust owner | Coverage |
|---|---|---|---|
| `test/tools` (incl. `cron/`, `background/`, `todo/`, …) | 52 | `lmcode-core/src/tools/*` + `cron.rs`, `background.rs`, `goal.rs`, `plan.rs` | U (each tool has unit tests) + R |
| `test/agent` (incl. `injection/`, `cron/`, `goal/`, `plan/`) | 38 | `lmcode-core/src/agent.rs`, `plan.rs`, `goal.rs`, `grader.rs` | U + R |
| `test/loop` | 11 | `lmcode-core/src/agent.rs` (turn loop) | U + `bench_harness.rs` |
| `test/mcp` | 10 | `lmcode-mcp` (client + config) | U (incl. mock-server e2e) |
| `test/plugin` | 7 | `lmcode-core/src/skill.rs` (skills replace the plugin surface used by LMD) | U |
| `test/session` | 6 | `lmcode-core/src/session.rs` | U |
| `test/utils` | 7 | scattered (`lmcode-llm` message helpers, config) | U |
| `test/skills`, `test/prompts`, `test/compaction`, `test/permission`, … | remainder | corresponding `lmcode-core` modules | U |

## apps/lmcode (CLI + TUI)

| Legacy test dir | Files | Rust owner | Coverage |
|---|---|---|---|
| `test/tui` (components/editor/messages/panels/dialogs/commands/utils) | ~55 | `lmcode-tui` (render/markdown/diff/mentions/picker/app/bridge) | U (37 tests) + R (winpty sessions); TUI event-loop entry (`lib.rs`) needs a TTY → R only |
| `test/cli` | 8 | `lmcode-cli` | C (`cli_surface.rs`, golden help) + R |
| `test/cli/update` | 8 | — | **S**: auto-update checks against the npm distribution channel; a source-built Rust binary has no npm channel — intentionally not ported |
| `test/migration` | (in root suite) | — | **S**: migrates *old Python lmcode-cli* data; that migration is legacy-data tooling, not LMD runtime behaviour — intentionally not ported (the Rust session store reads both layouts it needs) |

## Test count context

- Legacy: 3,724 tests in the replaced scope (≈45 per 1k source lines).
- Rust: 278 tests (≈10.5 per 1k lines) **plus** layers the legacy suite did
  not have: CLI contract + golden fixtures, live legacy-vs-Rust
  differential runs (`scripts/parity_check.sh`), a turn-loop benchmark, and
  per-batch recorded real-run verification.
- Deliberately not migrated (listed above with reasons): npm auto-update
  checks, Python-legacy data migration tooling, and tests that assert
  TypeScript-specific internals (module shapes, class instances) that have
  no Rust counterpart — their *behavioural* contracts are covered by the
  Rust unit/contract layers instead.

## Environment / toolchain independence

- `lm.exe` PE import scan (Python, byte search): only Windows system DLLs
  (`KERNEL32`, `ADVAPI32`, `bcrypt`, `WS2_32`, `ntdll`, `api-ms-win-*`);
  **zero** `node.dll`/`libnode`/`python3`/`libpython` imports.
- `cargo metadata`: dependency graph contains only the 7 `lmcode-*` crates
  + crates.io libraries; no Node/TS package is referenced by any build step
  (`build.rs` is a single `tauri_build::build()` call).
- Runtime: with `env -i` (empty environment, no Node on `PATH`) the binary
  builds, runs, and exports sessions (`CLEAN-ENV-REPRODUCED`).
