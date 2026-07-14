#!/usr/bin/env bash
# LMcode source installer for macOS/Linux.
# Prerequisites: Node.js >= 22.19.0 and Git.

set -euo pipefail

UPGRADE_MODE=false
FORCE_MODE=false
REQUIRED_PNPM_VERSION="11.7.0"

usage() {
    cat <<'EOF'
Usage: ./install.sh [--upgrade] [--force]

  --upgrade  Update an existing LMcode source checkout with a fast-forward pull.
  --force    Reset tracked files in an existing LMcode checkout to origin/main.

INSTALL_DIR may be used to choose the source checkout directory.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --upgrade) UPGRADE_MODE=true ;;
        --force) FORCE_MODE=true ;;
        --help|-h) usage; exit 0 ;;
        *) echo "[ERROR] Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

REPO="Lyin01/LMcode-cli"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; }

find_node() {
    local cmd ver_output major minor patch
    for cmd in node nodejs node22 node24 node25; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            continue
        fi
        ver_output=$($cmd --version 2>&1 | sed 's/^v//')
        if [[ "$ver_output" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
            major="${BASH_REMATCH[1]}"
            minor="${BASH_REMATCH[2]}"
            patch="${BASH_REMATCH[3]}"
            if [[ "$major" -gt 22 ]] || {
                [[ "$major" -eq 22 ]] &&
                { [[ "$minor" -gt 19 ]] || { [[ "$minor" -eq 19 ]] && [[ "$patch" -ge 0 ]]; }; }
            }; then
                command -v "$cmd"
                return 0
            fi
        fi
    done
    return 1
}

info "Checking Node.js >= 22.19.0..."
NODE_PATH=$(find_node) || {
    error "Node.js 22.19.0 or newer was not found"
    echo "Install it from https://nodejs.org/ and retry."
    exit 1
}
info "Node.js: $("$NODE_PATH" --version) ($NODE_PATH)"

canonicalize_path() {
    "$NODE_PATH" -e '
const fs = require("node:fs");
const path = require("node:path");
let current = path.resolve(process.argv[1]);
const suffix = [];
while (!fs.existsSync(current)) {
  const parent = path.dirname(current);
  if (parent === current) process.exit(1);
  suffix.unshift(path.basename(current));
  current = parent;
}
process.stdout.write(path.join(fs.realpathSync.native(current), ...suffix));
' "$1"
}

manifest_has_name() {
    "$NODE_PATH" -e '
const fs = require("node:fs");
try {
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(
    manifest !== null &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    manifest.name === process.argv[2]
      ? 0
      : 1,
  );
} catch {
  process.exit(1);
}
' "$1" "$2"
}

is_lmcode_checkout_at() {
    local checkout_dir="$1"
    [[ -d "$checkout_dir/.git" ]] &&
        [[ -f "$checkout_dir/package.json" ]] &&
        [[ -f "$checkout_dir/apps/lmcode/package.json" ]] &&
        manifest_has_name "$checkout_dir/package.json" "@lmcode-cli/monorepo" &&
        manifest_has_name "$checkout_dir/apps/lmcode/package.json" "@liumir/lmcode"
}

CANONICAL_HOME=$(canonicalize_path "$HOME") || {
    error "Unable to resolve HOME: $HOME"
    exit 1
}
LEGACY_DIR="$CANONICAL_HOME/.lmcode"
if is_lmcode_checkout_at "$LEGACY_DIR"; then
    DEFAULT_DIR="$LEGACY_DIR"
else
    DEFAULT_DIR="$CANONICAL_HOME/lmcode"
fi
INSTALL_DIR=$(canonicalize_path "${INSTALL_DIR:-$DEFAULT_DIR}") || {
    error "Unable to resolve INSTALL_DIR: ${INSTALL_DIR:-$DEFAULT_DIR}"
    exit 1
}
BIN_DIR="$INSTALL_DIR/bin"

if [[ "$INSTALL_DIR" == "/" || "$INSTALL_DIR" == "$CANONICAL_HOME" ]]; then
    error "Refusing unsafe INSTALL_DIR: $INSTALL_DIR"
    exit 1
fi

is_lmcode_checkout() {
    is_lmcode_checkout_at "$INSTALL_DIR"
}

has_legacy_user_data() {
    [[ -f "$INSTALL_DIR/config.toml" ]] ||
        [[ -f "$INSTALL_DIR/mcp.json" ]] ||
        [[ -d "$INSTALL_DIR/sessions" ]] ||
        [[ -d "$INSTALL_DIR/memory" ]] ||
        [[ -d "$INSTALL_DIR/user-history" ]] ||
        [[ -d "$INSTALL_DIR/logs" ]]
}

pnpm_version_is_compatible() {
    local ver_output major minor patch
    ver_output=$("$@" --version 2>/dev/null) || return 1
    if [[ ! "$ver_output" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        return 1
    fi
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"
    [[ "$major" -eq 11 ]] && {
        [[ "$minor" -gt 7 ]] || { [[ "$minor" -eq 7 ]] && [[ "$patch" -ge 0 ]]; }
    }
}

run_checked() {
    local label="$1"
    shift
    if ! "$@"; then
        error "$label failed"
        exit 1
    fi
}

if ! is_lmcode_checkout && [[ -e "$INSTALL_DIR" ]]; then
    error "Refusing to overwrite existing non-LMcode directory: $INSTALL_DIR"
    error "Choose an empty path with INSTALL_DIR. Existing files were not changed."
    exit 1
fi
if ! is_lmcode_checkout && { $UPGRADE_MODE || $FORCE_MODE; }; then
    error "No LMcode source checkout exists at $INSTALL_DIR"
    exit 1
fi

USE_LEGACY_DATA_HOME=false
if is_lmcode_checkout && has_legacy_user_data; then
    USE_LEGACY_DATA_HOME=true
fi

info "Checking Git..."
if ! command -v git >/dev/null 2>&1; then
    error "Git was not found. Install it from https://git-scm.com/downloads and retry."
    exit 1
fi
info "Git: $(git --version)"

info "Checking pnpm >= 11.7.0 and < 12..."
PNPM_COMMAND=()
if command -v pnpm >/dev/null 2>&1 && pnpm_version_is_compatible "$(command -v pnpm)"; then
    PNPM_COMMAND=("$(command -v pnpm)")
else
    warn "A compatible pnpm was not found; activating pnpm $REQUIRED_PNPM_VERSION."
    if command -v corepack >/dev/null 2>&1; then
        corepack prepare "pnpm@$REQUIRED_PNPM_VERSION" --activate >/dev/null 2>&1 || true
        if pnpm_version_is_compatible corepack pnpm; then
            PNPM_COMMAND=(corepack pnpm)
        fi
    fi
    if [[ ${#PNPM_COMMAND[@]} -eq 0 ]]; then
        PNPM_INSTALL_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/lmcode-pnpm-install.XXXXXX")
        trap 'rm -f "$PNPM_INSTALL_SCRIPT"' EXIT
        run_checked "Downloading pnpm installer" \
            curl -fsSL https://get.pnpm.io/install.sh -o "$PNPM_INSTALL_SCRIPT"
        run_checked "Installing pnpm $REQUIRED_PNPM_VERSION" \
            env PNPM_VERSION="$REQUIRED_PNPM_VERSION" sh "$PNPM_INSTALL_SCRIPT"
        export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
        export PATH="$PNPM_HOME:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
        hash -r
        if command -v pnpm >/dev/null 2>&1 && pnpm_version_is_compatible "$(command -v pnpm)"; then
            PNPM_COMMAND=("$(command -v pnpm)")
        fi
    fi
fi
if [[ ${#PNPM_COMMAND[@]} -eq 0 ]]; then
    error "pnpm $REQUIRED_PNPM_VERSION could not be activated"
    exit 1
fi
info "pnpm: $("${PNPM_COMMAND[@]}" --version)"

if is_lmcode_checkout; then
    if ! $UPGRADE_MODE && ! $FORCE_MODE; then
        error "LMcode is already installed at $INSTALL_DIR"
        echo "Run this installer with --upgrade to update it."
        exit 1
    fi

    info "Updating verified LMcode checkout: $INSTALL_DIR"
    if $FORCE_MODE; then
        warn "--force resets tracked files to origin/main and never runs git clean; back up local code changes first."
        run_checked "Fetching LMcode" git -C "$INSTALL_DIR" fetch --depth 1 origin main
        run_checked "Resetting LMcode tracked files" git -C "$INSTALL_DIR" reset --hard origin/main
    else
        run_checked "Updating LMcode" git -C "$INSTALL_DIR" pull --ff-only origin main
    fi
else
    info "Cloning LMcode into $INSTALL_DIR..."
    run_checked "Cloning LMcode" git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

info "Installing dependencies and building..."
run_checked "Installing dependencies" "${PNPM_COMMAND[@]}" --dir "$INSTALL_DIR" install --frozen-lockfile
run_checked "Building LMcode" "${PNPM_COMMAND[@]}" --dir "$INSTALL_DIR" -r build

info "Creating lm command..."
mkdir -p "$BIN_DIR"
ESCAPED_INSTALL_DIR=$(printf '%q' "$INSTALL_DIR")
ESCAPED_NODE_PATH=$(printf '%q' "$NODE_PATH")
LEGACY_HOME_LINE=""
if $USE_LEGACY_DATA_HOME; then
    LEGACY_HOME_LINE='export LMCODE_HOME="${LMCODE_HOME:-$LMCODE_SOURCE_DIR}"'
fi
cat > "$BIN_DIR/lm" <<EOF
#!/usr/bin/env bash
LMCODE_SOURCE_DIR=$ESCAPED_INSTALL_DIR
export LMCODE_INSTALL_DIR="\$LMCODE_SOURCE_DIR"
$LEGACY_HOME_LINE
exec $ESCAPED_NODE_PATH "\$LMCODE_SOURCE_DIR/apps/lmcode/dist/main.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/lm"

if [[ "${LMCODE_SKIP_PATH_UPDATE:-0}" != "1" && ":$PATH:" != *":$BIN_DIR:"* ]]; then
    SHELL_RC=""
    if [[ -n "${ZSH_VERSION:-}" || "$(basename "${SHELL:-}")" == "zsh" ]]; then
        SHELL_RC="$HOME/.zshrc"
    elif [[ -n "${BASH_VERSION:-}" || "$(basename "${SHELL:-}")" == "bash" ]]; then
        SHELL_RC="$HOME/.bashrc"
    fi

    printf -v PATH_LINE 'export PATH=%q:$PATH # lmcode' "$BIN_DIR"
    if [[ -n "$SHELL_RC" && -f "$SHELL_RC" ]]; then
        if ! grep -Fqx "$PATH_LINE" "$SHELL_RC"; then
            printf '\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
        fi
        info "Added $BIN_DIR to PATH in $SHELL_RC"
    else
        echo "Add this directory to PATH: $BIN_DIR"
    fi
fi

export PATH="$BIN_DIR:$PATH"

info "Installation complete"
echo ""
echo "Install location: $INSTALL_DIR"
echo "Run:              lm --version"
