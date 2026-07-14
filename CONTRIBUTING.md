# Contributing to LMcode

Thank you for your interest in contributing!

## Getting Started

- Node.js >= 22.0.0
- pnpm 11.7.0

```bash
pnpm install
pnpm run build
pnpm test
```

## Development Workflow

1. Open an issue before sending a feature PR.
2. Follow the pull request template.
3. Add tests for new functionality.
4. Call out user-visible release notes in the pull request description.

## Project Structure

- `apps/lmcode`: CLI / TUI application
- `apps/lmcode-desktop`: Desktop application
- `packages/agent-core`: Agent engine
- `packages/node-sdk`: Public TypeScript SDK
- `packages/ltod`: LLM provider abstraction
- `packages/jian`: Execution environment
- `packages/memory`: Memory storage and scoring
- `packages/config`: Shared configuration and model aliases
