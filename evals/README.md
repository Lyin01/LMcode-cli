# LMcode agent evals

A minimal, runnable harness for scoring the agent's **end-to-end task quality**
with an objective pass/fail number — the missing complement to the repo's unit
and integration tests. Use it to turn "the prompt feels worse" into a number you
can track across prompt/model changes.

It drives a real [`@lmcode-cli/lmcode-sdk`](../packages/node-sdk) session against
a chosen provider, lets the agent work in a throwaway temp workdir, then scores
the **resulting files on disk** — never the transcript — so verdicts are
reproducible and model-agnostic.

> Scope: a solid, extensible skeleton — not SWE-bench. Two sample tasks ship; add
> your own (see "Adding a task").

---

## Run the keyless smoke (no API key)

```bash
pnpm eval                 # run all tasks (real-model ones skip without a model)
pnpm eval smoke-plumbing  # run just the keyless plumbing task
```

`smoke-plumbing` runs against a **fake provider** — a tiny local
OpenAI-compatible server (`framework/fake-provider.ts`) that a real `lmcode`
provider connects to. No network, no keys. It proves the whole pipeline works
(session drives → a turn completes → the scorer runs), so it's safe for CI.

**It is plumbing only.** A fake model emits a fixed string and cannot edit
files, so a PASS here means "the harness is healthy", *not* "the agent is good".
Real quality is measured by real-model tasks like `fix-failing-fn`.

Expected output:

```
Running 1 eval task(s): smoke-plumbing

→ smoke-plumbing (fake) ... PASS

TASK            STATUS  SCORE  DURATION  TOKENS
--------------  ------  -----  --------  ------
smoke-plumbing  PASS    1.00   0.82s     18

1 ran, 1 passed, 0 failed (100%), 0 skipped
```

The process exits non-zero iff a non-skipped task fails (CI-friendly). Skipped
tasks never fail the run.

---

## Run real-model evals (gated)

Real-model tasks are **skipped automatically** unless a model is configured via
env. Nothing is hardcoded — you supply the key.

| Env var                 | Required | Meaning                                                                 |
| ----------------------- | -------- | ----------------------------------------------------------------------- |
| `LMCODE_EVAL_MODEL`     | yes      | Model id sent to the provider (e.g. `gpt-4o-mini`, `claude-sonnet-4-5`). |
| `LMCODE_EVAL_API_KEY`   | yes      | API key for the provider.                                               |
| `LMCODE_EVAL_PROVIDER`  | no       | `anthropic` \| `openai` \| `openai_responses` \| `lmcode` \| `google-genai`. Default `lmcode`. |
| `LMCODE_EVAL_BASE_URL`  | no       | Base URL override (self-hosted gateway, proxy, etc.).                   |
| `LMCODE_EVAL_MAX_CONTEXT` | yes    | Model context window used for compaction. Required for real-model tasks; unset tasks SKIP. |

Example (bash):

```bash
LMCODE_EVAL_PROVIDER=openai \
LMCODE_EVAL_MODEL=gpt-4o-mini \
LMCODE_EVAL_API_KEY=sk-... \
pnpm eval fix-failing-fn
```

The session runs in `yolo` permission mode so the agent can edit files without
an interactive approver. The runner waits until the session is idle (including
any goal-drive follow-up turns), not the first `turn.ended`. A last turn that
`failed` or was `cancelled` is a harness error, not a scored attempt.

Eval sessions pin a coding-only tool surface (no Goal / Agent / WolfPack /
Plan / MCP), disable self-healing and Anchored Bootstrap, cap steps at 80, and
sandbox writes to the workdir so scoring measures the task instead of harness
side paths.

The shipped real-model tasks:

| Task | Axis | Scoring |
| ---- | ---- | ------- |
| `fix-failing-fn` | fix one buggy function | binary: `node check.mjs` exits 0 |
| `env-parser` | implement a `.env` parser from a written `SPEC.md` | **partial credit**: `score = (visible + hidden) / total`; `passed` = all visible *and* hidden cases. Editing `test/` is a hard fail. |
| `csv-median-debug` | localize + fix bugs across two files | `score = passing / 8`; `passed` = all pass. Scored against authoritative inline cases, so editing the workdir test can't inflate it. |
| `expr-eval` | deep reasoning: a precedence-correct expression evaluator | same scoring as `env-parser` (hidden cases count toward `passed`). Hidden cases concentrate on precedence/associativity traps (right-assoc `^`, unary vs. `^`). |
| `spec-drift` | spec consistency: one prompt embedding five explicit details (second file, edge-case rules mid-sentence) | **detail coverage**: `score = details met / 5`; `passed` = all five. Measures whether the agent addresses *everything* asked — the axis the spec-consistency critic targets — rather than just the headline task. |

The `score` is a soft [0,1] number. Hidden or fixture-tamper misses now fail
`passed` as well as lowering `score`, so CI cannot go green on incomplete spec
coverage.

Example (DeepSeek, OpenAI-compatible):

```bash
LMCODE_EVAL_PROVIDER=openai \
LMCODE_EVAL_BASE_URL=https://api.deepseek.com \
LMCODE_EVAL_MODEL=deepseek-v4-flash \
LMCODE_EVAL_API_KEY=sk-... \
LMCODE_EVAL_MAX_CONTEXT=128000 \
pnpm eval env-parser csv-median-debug
```

### Observe the number in CI

`.github/workflows/evals.yml` runs these on demand (Actions → **Agent evals
(manual)** → *Run workflow*) and writes the scorecard to the run's **job
summary**. It does *not* run on push/PR (real evals cost tokens). Set the repo
secret **`LMCODE_EVAL_API_KEY`**; provider/model/base-URL are workflow inputs
(defaulted to DeepSeek). With no secret the real tasks SKIP and the keyless
harness smoke still runs, so the workflow stays green.

---

## Run the harness unit tests

The pure report/aggregate logic is covered by vitest. `evals/` is outside the
root workspace `projects` globs, so it uses its own config:

```bash
pnpm eval:test
# or: pnpm exec vitest run --config evals/vitest.config.ts
```

---

## How it's wired

The eval runtime imports the self-contained SDK bundle from
`packages/node-sdk/dist/index.mjs` via `tsconfig.runtime.json`. `pnpm eval`
builds all workspace packages first, so SDK, agent-core, and system-prompt
changes are always reflected before a task runs. The base `tsconfig.json` keeps
pointing at SDK source so type-aware linting and editor diagnostics retain the
complete TypeScript surface.

Using the built bundle also keeps evaluation behavior identical across the
supported Node 22 platforms. Workspace source uses package-scoped `#/...`
imports plus raw `.md` / `.yaml` prompt imports; those are resolved by the
normal build pipeline instead of relying on runtime loader hooks whose chaining
semantics differ across Node releases.

---

## Adding a task

A `Task` (see `framework/types.ts`) is a fixture + a prompt + a scorer:

```ts
import type { Task } from '../framework';

export const myTask: Task = {
  id: 'my-task',
  description: 'One-line summary shown in the report',
  kind: 'real', // 'fake' = keyless plumbing; 'real' = needs a configured model

  async setup(workdir) {
    // Write fixture files into the fresh temp workdir.
  },

  prompt: 'Instruction handed to the agent verbatim.',

  async score(workdir) {
    // Inspect ONLY the resulting disk state (run a check, read a file, …).
    // Return { passed, score (0..1), details }.
    return { passed: true, score: 1, details: 'why it passed' };
  },
};
```

Then register it in `run.ts`:

```ts
import { myTask } from './tasks/my-task';
const ALL_TASKS = [smokePlumbingTask, fixFailingFnTask, myTask];
```

Run it with `pnpm eval my-task`.

**Scorer rule:** depend only on observable disk state, never the transcript, so
the verdict is reproducible and model-independent. Prefer dependency-free checks
(a plain `node script.mjs` that exits 0/1) so scoring needs no extra install.

---

## Files

```
evals/
  run.ts                       entry point (task selection, reporting, exit code)
  tsconfig.json                maps SDK imports to source for static analysis
  tsconfig.runtime.json        maps SDK imports to the built runtime bundle
  vitest.config.ts             standalone config for evals/**/*.test.ts
  framework/
    types.ts                   Task / ScoreResult / RunResult
    runner.ts                  drives one task via the SDK, scores the workdir
    session-idle.ts            wait until all turns (including goal drive) finish
    fixture-guard.ts           fail if protected test/check files were edited
    runner.test.ts             idle-wait + failed/cancelled reason tests
    report.ts                  pure table/aggregate formatting (unit-tested)
    report.test.ts             vitest for the pure report logic
    providers.ts               fake + real provider/model setup from env
    providers.test.ts          env resolution + required context window
    fake-provider.ts           keyless local OpenAI-compatible stub server
    index.ts                   framework barrel
  tasks/
    smoke-plumbing.ts          keyless plumbing check (fake provider)
    fix-failing-fn.ts          real-model: fix a bug so the check passes
    env-parser.ts              real-model: implement from spec; visible + hidden scoring
    csv-median-debug.ts        real-model: localize + fix bugs across two files
    expr-eval.ts               real-model: precedence-correct evaluator (deep reasoning)
    spec-drift.ts              real-model: five embedded spec details, scored by coverage
```
