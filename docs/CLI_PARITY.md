# CLI Parity: legacy (`apps/lmcode`) vs Rust (`crates/lmcode-cli`)

This document maps the legacy CLI surface (`apps/lmcode/src/cli/commands.ts`
+ `options.ts` + `sub/export.ts`) to the Rust `lm` binary, one entry per
public option/sub-command. The mapping is enforced by
`crates/lmcode-cli/tests/cli_surface.rs` (every entry below is asserted
present in `--help` output, and every conflict case asserts a non-zero exit
with the legacy message).

## Options

| Legacy | Rust | Notes |
|---|---|---|
| `[prompt...]` (positional) | `[PROMPT]...` | joined with spaces; equivalent to `-p` |
| `-p, --prompt [prompt]` | `-p, --prompt [<PROMPT>]` | optional value: bare `-p` = empty prompt (rejected with 提示不能为空。); `--print` is **rejected** exactly like the legacy CLI |
| `-m, --model <model>` | `-m, --model <MODEL>` | |
| `-y, --yolo` | `-y, --yolo` | |
| `--yes` (hidden) | `--yes` (hidden) | yolo alias |
| `--auto-approve` (hidden) | `--auto-approve` (hidden) | yolo alias |
| `--auto` | `--auto` | auto permission mode: non-sensitive calls auto-approved; sensitive paths still ask |
| `-C, --continue` | `-C, --continue` | `-c` kept as a visible short alias |
| `-S, --session [id]` | `-S, --session [ID]` | no ID → most recent session for this directory |
| `-r, --resume [id]` | `-r, --resume [ID]` | alias of `-S` |
| `-p` + `--plan` | rejected | same conflict message |
| `--output-format text\|stream-json` | `--output-format <text\|stream-json>` | prompt mode only |
| `--skills-dir <dir>` (repeatable) | `--skills-dir <DIR>` (repeatable) | replaces auto-discovery |
| `--plan` | `--plan` | starts the session in plan mode |
| `-h, --help` / `-V, --version` | same | |

Rust-only extras (no legacy counterpart): `--tui`, `--config <PATH>`.

## Sub-commands

| Legacy | Rust | Status |
|---|---|---|
| `lm export [sessionId] [-o path] [-y] [--no-include-global-log]` | same flags | implemented; ZIP contains `manifest.json` (legacy field names + `runtime: "rust"`) + `session/` files (+ `logs/lmcode.log` when present) |
| `lm channel setup` | same | implemented; cc-connect detection, 11-platform picker, generates/appends `~/.cc-connect/config.toml` |
| `lm stream-json` (hidden, cc-connect protocol) | same flags accepted | implemented; stdin stream-json user messages → NDJSON events on stdout |
| `lm migrate` | same notice | **implemented as the same disabled stub**: prints 迁移功能已取消，不再支持从 lmcode-cli 导入数据。 and exits 0 (byte-identical to legacy) |
| `lm __plugin_run_node` (hidden) | not ported | Node plugin runner; not applicable to a native binary |

## Conflict validation (`validateOptions`)

Ported one-to-one (same messages, same conditions), exercised by the
`conflicting_options_are_rejected` test:

| Condition | Message |
|---|---|
| empty prompt | 提示不能为空。 |
| empty model | 模型不能为空。 |
| `--output-format` without prompt mode | 输出格式仅在提示模式下支持。 |
| prompt mode + `--plan` | --prompt 不能与 --plan 同时使用。 |
| prompt mode + `-S` without ID | 在提示模式下不能使用不带 ID 的 --session。 |
| `--continue` + `--session`/`--resume` | --continue 和 --session 不能同时使用。 |
| `--yolo` + `--auto` | --yolo 不能与 --auto 同时使用。 |
| resume + `--yolo` / `--auto` / `--plan` (non-prompt) | --yolo/--auto/--plan 不能与 --continue 或 --session 同时使用。 |

## How this was verified

- **Original test vectors**: the legacy suite's own option vectors
  (`apps/lmcode/test/cli/options.test.ts`, 30+ cases) were executed against
  the Rust binary in `cli_surface.rs::legacy_option_test_vectors` /
  `legacy_vectors_that_pass_validation`: bare `-p` → 提示不能为空。; blank
  model → 模型不能为空。; all 16 removed flags rejected; the
  “passes validation” vectors (prompt + `--continue`/`--session`/`--yolo`/
  `--auto`, positional + `--output-format`, the `-p --output-format …
  "explain this repo"` regression) do not hit any conflict message.

- **Side-by-side run** (`scripts/parity_check.sh`): the legacy CLI
  (`pnpm -C apps/lmcode run dev -- …`) and the Rust binary were run on the
  same non-LLM input set (conflict cases + `-V`). Result for all five
  conflict cases: **identical stderr text** (`错误：…`) and **identical exit
  code (1)**. Example:

  ```
  $ lm --yolo --auto            (legacy)   → 错误：--yolo 不能与 --auto 同时使用。  exit 1
  $ lm --yolo --auto            (rust)     → 错误：--yolo 不能与 --auto 同时使用。  exit 1
  ```

  Documented difference: `-V` prints `0.9.24` (legacy) vs `lm 0.1.0` (Rust,
  clap convention) — the version *number* necessarily differs between
  implementations; both exit 0.
- **Option surface**: `cargo test -p lmcode-cli --test cli_surface` — every
  row of the option table is asserted against real `--help` output, plus a
  checked-in golden fixture (`tests/fixtures/help.golden.txt`).
- **Legacy side**: the legacy CLI was run locally via
  `pnpm -C apps/lmcode run dev -- --help` (and `export --help`) and its
  output compared row-by-row with the Rust `--help` output.
- **Real runs**: `-S <id>` / `-r` resume (message counts grow 2→4→6 on the
  same session), `--plan` (plan file created), `--skills-dir` (skills
  loaded from the given directory), `--output-format stream-json` (NDJSON
  events captured), `export` (ZIP inspected with `zipfile`), `stream-json`
  (stdin message → assistant event captured).
- **No legacy calls from production code**: `grep -rn "packages/\|apps/" crates/ --include="*.rs"`
  matches only doc comments (`//! Mirrors apps/lmcode/…`) plus the LSP
  registry's `typescript-language-server` entry (a feature of the LSP
  tool, not a legacy dependency). Binary scan of the shipped `lm.exe`
  (Python `bytes.count`): `node_modules` → **0** occurrences; the only
  `typescript`/`.tsx` hits are the LSP command/language-id tables and a
  "Supported file extensions" doc string.
- **Startup performance (measured, median of 3)**: Rust `lm -V` **15 ms**,
  `lm --help` 16 ms vs legacy (node, no pnpm wrapper) `--version` 122 ms,
  `--help` 123 ms — the Rust binary is **~8× faster** to start and well
  under any "not slower than baseline" bound.
- **End-to-end file output**: `lm -p "…"` (turn) → `lm export -o out.zip`
  → archive verified with Python `zipfile`: entries `manifest.json`,
  `session/messages.jsonl`, `session/state.json` (`E2E-FILE-VERIFIED`).
- **Clean environment reproducibility**: with `env -i` (empty environment,
  no Node on `PATH`) and a binary built from the **Rust-only tree** (no TS
  sources present), `--version`, `-p …` and `export -y` all succeed and the
  export archive is written (`CLEAN-ENV-REPRODUCED`).
