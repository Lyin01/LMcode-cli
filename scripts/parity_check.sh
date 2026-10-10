#!/usr/bin/env bash
# Side-by-side parity check: legacy CLI (apps/lmcode, via pnpm) vs the Rust
# binary, on inputs that do NOT touch the LLM provider (help / version /
# option-conflict validation). Run from the repository root.
#
# Usage: bash scripts/parity_check.sh [path-to-rust-lm]
set -u

RUST_BIN="${1:-./target/release/lm.exe}"
[[ -x "$RUST_BIN" ]] || RUST_BIN="./target/debug/lm.exe"

run_legacy() {
  pnpm -C apps/lmcode run dev -- "$@" 2>&1 | grep -v '^\$ node' || true
  echo "exit:${PIPESTATUS[0]:-?}"
}

run_rust() {
  "$RUST_BIN" "$@" 2>&1
  echo "exit:$?"
}

compare() {
  local label="$1"; shift
  echo "━━━ $label  (args: $*)"
  echo "--- legacy"
  run_legacy "$@" | tail -5
  echo "--- rust"
  run_rust "$@" | tail -5
  echo
}

# Conflict inputs (validated before any provider setup on both sides).
compare "conflict: --yolo + --auto" --yolo --auto
compare "conflict: -p empty prompt" -p ""
compare "conflict: -p + --plan" -p x --plan
compare "conflict: -p + -S without id" -p x -S
compare "conflict: --output-format without prompt mode" --output-format stream-json
compare "conflict: empty model" -m "" -p x
compare "conflict: --continue + --session" --continue --session abc

# Version output.
echo "━━━ version (-V)"
echo "--- legacy"; run_legacy --version
echo "--- rust";   run_rust -V
echo

# Sub-command help (surface comparison; the help *formats* differ by design:
# commander vs clap — what must match is the accepted flag set, asserted by
# tests/cli_surface.rs::subcommands_match_the_legacy_surface).
echo "━━━ subcommand: export --help (surface)"
echo "--- legacy"; run_legacy export --help | head -10
echo "--- rust";   run_rust export --help | head -10
echo

# New vectors from the legacy options test suite.
compare "bare -p (empty prompt)" -p
compare "removed flag --print" --print x
echo "━━━ migrate (disabled notice)"
echo "--- legacy"; run_legacy migrate | tail -2
echo "--- rust";   run_rust migrate | tail -2
echo
