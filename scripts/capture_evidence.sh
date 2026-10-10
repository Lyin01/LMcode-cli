#!/usr/bin/env bash
# Capture raw evidence for the completion review into docs/EVIDENCE.txt.
# Run from the repository root.
set -u
ROOT="$(pwd)"
OUT="$ROOT/docs/EVIDENCE.txt"
: > "$OUT"

section() { echo; echo "=================================================================="; echo "== $*"; echo "=================================================================="; }

{
section "0. Project identity"
echo "repo: $(basename "$PWD")  remote: $(git remote get-url origin 2>/dev/null || echo none)"
echo "user-confirmed objective: LMD = LMCODE DESKTOP (Rust rewrite of this repository)"

section "1. Gate commands (raw exit codes)"
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all --check; echo "cargo fmt --all --check exit: $?"
cargo clippy --workspace --all-targets -- -D warnings >/dev/null 2>&1; echo "cargo clippy -D warnings exit: $?"
cargo test --workspace --all-targets > /tmp/ev-test.log 2>&1; echo "cargo test --all-targets exit: $?"
grep -E "^test result" /tmp/ev-test.log | awk -F'[ ;]' '{s+=$4; f+=$6; i+=$7} END {print "  passed="s" failed="f" ignored="i}'
cargo test --workspace --all-features --all-targets > /tmp/ev-af.log 2>&1; echo "cargo test --all-features exit: $?"
grep -E "^test result" /tmp/ev-af.log | awk -F'[ ;]' '{s+=$4; f+=$6; i+=$7} END {print "  all-features passed="s" failed="f" ignored="i}'
cargo build --workspace --release > /tmp/ev-build.log 2>&1; echo "cargo build --release exit: $?"
echo "  warnings/errors in build log: $(grep -ciE '^warning|^error' /tmp/ev-build.log)"
ls -la target/release/lm.exe target/release/lmcode-desktop.exe | awk '{print "  artifact:", $5, $9}'

section "2. Legacy vs Rust: original option vectors (live comparison)"
bash scripts/parity_check.sh ./target/release/lm.exe 2>&1 | grep -vE '^\$ node|ELIFECYCLE'

section "3. Self-containment proofs"
echo "-- cargo metadata (workspace crates + legacy deps)"
cargo metadata --format-version 1 2>/dev/null | python -c "
import json,sys
d=json.load(sys.stdin); names={p['name'] for p in d['packages']}
print('  lmcode crates:', sorted(n for n in names if n.startswith('lmcode')))
print('  total packages in graph:', len(names))
"
echo "-- PE import scan (lm.exe)"
python -c "
data=open('target/release/lm.exe','rb').read()
for d in [b'node.dll',b'libnode',b'python3',b'libpython',b'KERNEL32.dll',b'WS2_32.dll']:
    c=data.count(d)
    print(f'  {d.decode():14} x{c}')
"
echo "-- binary scan: node_modules / typescript"
python -c "
data=open('target/release/lm.exe','rb').read()
print('  node_modules:', data.count(b'node_modules'))
print('  typescript (LSP tables only):', data.count(b'typescript'))
"
echo "-- env -i (no Node on PATH): version + prompt + export"
T=$(mktemp -d); TW=$(cygpath -m "$T"); mkdir -p "$T/home" "$T/work"; cp "$HOME/.lmcode/config.toml" "$T/home/config.toml"
cd "$T/work"
env -i PATH="/usr/bin:/bin" HOME="$TW/home" LMCODE_HOME="$TW/home" "$ROOT/target/release/lm.exe" --version
env -i PATH="/usr/bin:/bin" HOME="$TW/home" LMCODE_HOME="$TW/home" timeout 120 "$ROOT/target/release/lm.exe" -p "Reply with exactly: EVIDENCE-OK"
env -i PATH="/usr/bin:/bin" HOME="$TW/home" LMCODE_HOME="$TW/home" timeout 60 "$ROOT/target/release/lm.exe" export -y >/dev/null && echo "export: file written ($(ls "$T/work"/*.zip | wc -l) zip)"

section "4. End-to-end file output (input -> process -> output)"
python - << PYEOF
import zipfile, glob
z = glob.glob(r'$TW/work/*.zip')[0]
with zipfile.ZipFile(z) as f:
    names = f.namelist()
    print('  zip entries:', names)
    assert 'manifest.json' in names and any(n.startswith('session/') for n in names)
    print('  E2E-FILE-VERIFIED')
PYEOF

section "5. Performance benchmarks"
echo "-- turn-loop throughput (scripted provider, release)"
cargo test -p lmcode-core --release --test bench_harness -- --nocapture 2>&1 | grep "bench:"
echo "-- startup comparison (median of 3, python timer)"
python - << 'PYBENCH'
import subprocess, time, statistics
def bench(label, cmd, n=3):
    times = []
    for _ in range(n):
        start = time.perf_counter()
        subprocess.run(cmd, capture_output=True, shell=True)
        times.append(time.perf_counter() - start)
    print(f"  {label}: median {statistics.median(times)*1000:.0f} ms")
bench("Rust lm -V", "./target/release/lm.exe -V")
bench("Rust lm --help", "./target/release/lm.exe --help")
bench("legacy --version (node)", "node scripts/dev.mjs -- --version", n=2)
PYBENCH

echo
echo "== EVIDENCE CAPTURE COMPLETE =="
} >> "$OUT" 2>&1

echo "written: $OUT ($(wc -l < "$OUT") lines)"
