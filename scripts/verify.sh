#!/usr/bin/env bash
# Local mirror of .github/workflows/ci.yml — the exact gate sequence CI runs.
# Run from the repository root (or a clean checkout of it).
set -euo pipefail

step() { echo; echo "===== $* ====="; }

step "cargo fmt --all --check"
cargo fmt --all --check
echo "fmt: PASS"

step "cargo clippy --workspace --all-targets -- -D warnings"
cargo clippy --workspace --all-targets -- -D warnings
echo "clippy: PASS"

step "cargo test --workspace --all-targets"
cargo test --workspace --all-targets
echo "tests: PASS"

step "cargo build --workspace --release"
cargo build --workspace --release
echo "release build: PASS"

step "cargo doc --workspace --no-deps"
cargo doc --workspace --no-deps
echo "doc: PASS"

echo
echo "ALL GATES PASSED"
