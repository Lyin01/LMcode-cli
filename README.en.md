<p align="center">
  <img width="112" height="112" alt="LMcode" src="assets/logo.svg" />
</p>

<h1 align="center">LMcode</h1>

<p align="center">
  A terminal-native AI coding agent — a fast, scriptable TUI CLI for builders.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/v/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@liumir/lmcode"><img src="https://img.shields.io/npm/dm/@liumir/lmcode?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/github/stars/Lyin01/LMcode-cli?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/commits/main"><img src="https://img.shields.io/github/last-commit/Lyin01/LMcode-cli?style=flat-square" alt="last commit"></a>
  <a href="https://github.com/Lyin01/LMcode-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lyin01/LMcode-cli?style=flat-square" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/Lyin01/LMcode-cli"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"></a>
</p>

<p align="center">
  <b>English</b> | <a href="README.md">中文</a>
</p>

LMcode runs in your terminal: it reads code, edits files, and executes commands in the current project, and it can drive tasks that need many turns to finish. The default UI language is Chinese; the model provider is fully configurable and can be switched inside the same TUI.

The project is at `0.x` and actively maintained by a solo developer — ~3,700 npm downloads in its first month and 29 releases in 5 weeks. Config formats and behavior may still change between releases.

## Install

Requires [Node.js](https://nodejs.org/) `>= 22.19.0`.

```bash
npm install -g @liumir/lmcode
```

Run it inside a project:

```bash
cd your-project
lm
```

On first launch, run `/config` to pick a model provider and model, then sign in or paste an API key. Afterwards use `/config` to manage providers and `/model` to switch models.

## Highlights

- **Terminal-native TUI** — streaming responses, transcript view, todo panel, activity and queue panes; resume the last session in a directory with `lm -C`.
- **Scriptable one-shot mode** — `lm -p "prompt" --output-format stream-json` for CI and automation pipelines.
- **Multi-provider LLM client** — the `ltod` package streams from multiple providers; switch models and reasoning effort mid-session with `/model`.
- **Three-stage compaction pipeline** — micro-compaction (zero-LLM truncation), full LLM summarization, and a blocking safety net, triggered predictively before context overflow.
- **Goal mode (`/goal`)** — persistent objectives that survive turns and session resumes, with working notes injected each continuation.
- **Wolfpack mode (`/wolfpack`)** — parallel sub-agent orchestration (template + up to 20 items per batch) with auto-approval of routine tools while sensitive paths still require confirmation.
- **Memory system** — cross-session task-experience records with semantic tags, scored retrieval (`MemoryLookup`), and a four-stage `/dream` consolidation pass.
- **MCP built in** — manage Model Context Protocol servers from the `/mcp` panel (user-global and project-local config).
- **Plugins & Skills** — skills are auto-discovered from user and project directories (`~/.lmcode/skills`, `<project>/.agents/skills`, …) and can be exposed as slash commands.
- **Permission modes** — `manual` / `auto` / `yolo`; sensitive files, git-controlled paths, and out-of-cwd writes keep asking for confirmation even in `auto`.

## Usage

Describe what to change and which checks to run when done, e.g.:

```text
Find why the current tests fail, fix it, then run the related tests. Do not touch unrelated files.
```

One-shot, non-interactive runs:

```bash
lm "Summarize this repo's entry points and module boundaries"
lm -p "Review uncommitted changes in the worktree" --output-format stream-json
```

Long-running and parallel work:

```text
/goal Fix release-blocking issues, add the necessary tests, and pass the build checks
/wolfpack    # let the model fan out parallelizable work to sub-agents
```

## Common entry points

| Entry | Purpose |
| --- | --- |
| `lm` | Open the interactive TUI |
| `lm -C` | Continue the most recent session in this directory |
| `lm -S [id]` | Pick or directly resume a session |
| `lm --plan` | Start in plan mode |
| `lm --auto` | Auto-approve routine operations, keep sensitive-path guards |
| `lm --yolo` | Explicit yolo permission mode (also the current startup default) |
| `/config` | Configure model providers |
| `/model` | Switch model and reasoning effort |
| `/permission` | Switch permission mode |
| `/goal` | Create, view, pause, or resume a goal |
| `/wolfpack` | Toggle multi-agent parallel mode |
| `/sessions` | Browse past sessions |
| `/memory` | Search and inject memories |
| `/mcp` | Install, disable, or remove MCP servers |
| `/plugin` | Browse and manage plugins |
| `/help` | Full command and shortcut list |

See `lm --help` for the complete CLI option list.

## Data & permissions

LMcode is not an offline tool — know where your data goes:

- Config, sessions, memory, and most run records stay on your machine under `~/.lmcode` (override with `LMCODE_HOME`).
- Prompts, necessary file contents, and tool results are sent to the model provider you configured.
- Web search, URL fetching, MCP, and cc-connect send related data to their respective external services.
- File-boundary checks cover the built-in file tools that declare file access (Read/Write/Edit/MultiEdit…). `Bash`, MCP tools, and user-defined tools do not declare file access — constrain them with `manual` mode or deny rules.

## Roadmap

- **Toward v1.0**: stabilize the configuration format and the public CLI/SDK surface.
- **v1.0 cleanup**: remove the deprecated `migration-legacy` package (documented sunset plan).
- **Desktop app**: `apps/lmcode-desktop` is in the monorepo and under active development.
- **Ecosystem**: broader provider coverage, more plugins and bundled skills.

## Development

pnpm workspace monorepo. Requires Git, Node.js `>= 22.19.0`, and pnpm `>= 11.7.0 < 12`.

```bash
git clone https://github.com/Lyin01/LMcode-cli.git
cd LMcode-cli
corepack enable
pnpm install
pnpm run dev:cli
```

Pre-commit checks:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

Repository layout:

```text
apps/lmcode              CLI and terminal UI, published as @liumir/lmcode
apps/lmcode-desktop      Desktop app
packages/agent-core      Agent runtime: tools, permissions, sessions, MCP, goal loop
packages/ltod            Streaming client for multiple model providers
packages/node-sdk        TypeScript SDK for the app layer
packages/jian            Filesystem, process, and execution-environment abstraction
packages/memory          Cross-session memory store and retrieval
packages/config          Configuration, identity, and model aliases
```

Code conventions and testing requirements: [CONTRIBUTING.md](CONTRIBUTING.md).

## Origin

LMcode was originally forked from [Scream Code](https://github.com/LIUTod/scream-code) and is now maintained by [Lyin01](https://github.com/Lyin01). Thanks to [LIUTod](https://github.com/LIUTod) for the original implementation and open-source work.

## License

[MIT](LICENSE)
