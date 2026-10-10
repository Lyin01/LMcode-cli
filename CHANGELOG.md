# Changelog

## Rust rewrite (unreleased)

### Added

- **Rust workspace** (7 crates, ~26.5k lines): `lmcode-core` (agent, tools,
  plan/goal/cron/background/subagents, MCP, memory, LSP, session),
  `lmcode-llm` (providers), `lmcode-mcp`, `lmcode-memory`, `lmcode-tui`,
  `lmcode-cli` (`lm`), `lmcode-desktop` (Tauri app).
- **`lm` CLI**: full legacy surface — `-p/--prompt` (+ positional, optional
  value), `-m/--model`, `-y/--yolo` (+ hidden `--yes`/`--auto-approve`),
  `--auto`, `-C/--continue` (+ `-c` alias), `-S/--session [id]`,
  `-r/--resume [id]`, `--plan`, `--skills-dir`, `--output-format
  text|stream-json`, `--config` (Rust-only extension); option-conflict
  validation ported case-by-case from `validateOptions`.
- **Sub-commands**: `lm export` (session ZIP with legacy-compatible
  `manifest.json`), `lm channel setup` (cc-connect wizard, 11 platforms),
  `lm migrate` (disabled stub, byte-identical notice), hidden
  `lm stream-json` (cc-connect protocol).
- **Desktop app** (Tauri): chat + approvals, sessions, settings/model
  switch, memory browser, Git review, terminal, automation, worktrees,
  subagents, inbox, artifact preview, remote-connection panel (LAN HTTP +
  token pairing + SSE).
- **Quality gates**: `scripts/verify.sh` (CI mirror), `scripts/parity_check.sh`
  (live legacy-vs-Rust differential), `scripts/capture_evidence.sh`;
  `.github/workflows/ci.yml` gains a `rust` job (fmt/clippy/test/release/doc)
  alongside the existing security/build/test/lint/typecheck jobs.

### Migration notes

- The Rust workspace is an **additional implementation** of the LMcode
  desktop/CLI, not a deletion of the TypeScript monorepo — the TS packages
  remain the active npm-distributed release line.
- Behavioural parity was verified against the live legacy CLI: 9 recorded
  option vectors replay byte-for-byte
  (`crates/lmcode-cli/tests/fixtures/legacy_option_vectors.txt` +
  `cli_parity_golden.rs`), including identical `错误：…` messages and exit
  codes for all conflict cases.
- Known, documented differences: `-V` prints `lm 0.1.0` vs the legacy bare
  version string (clap vs commander convention); clap's error wording for
  unknown options differs (same rejection + same exit code 1, and both
  suggest `--prompt`); `--config` is a Rust-only extension for selecting a
  config path.
- `lm migrate` keeps the legacy disabled-stub behaviour (identical notice,
  exit 0). npm auto-update checks and Python-legacy data-migration tooling
  are intentionally not ported (see `docs/TEST_MIGRATION.md`).

### Documentation

- `docs/CLI_PARITY.md` — command-by-command mapping + verification.
- `docs/TEST_MIGRATION.md` — legacy test-suite mapping and omissions.
- `docs/COVERAGE.md` — llvm-cov report + baseline comparison.
- `docs/PROJECT_IDENTITY.md` — scope confirmation (LMD = LMcode Desktop).
- `docs/EVIDENCE.txt` — captured raw evidence (gates, parity, benchmarks).
