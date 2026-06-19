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
| `LMCODE_EVAL_MAX_CONTEXT` | no     | Max context size for the model alias. Default `262144`.                 |

Example (bash):

```bash
LMCODE_EVAL_PROVIDER=openai \
LMCODE_EVAL_MODEL=gpt-4o-mini \
LMCODE_EVAL_API_KEY=sk-... \
pnpm eval fix-failing-fn
```

`fix-failing-fn` sets up a tiny project with a buggy `sum()` plus a
dependency-free `check.mjs`, asks the agent to fix it, then runs `node check.mjs`
and passes iff it exits 0. The session runs in `yolo` permission mode so the
agent can edit files without an interactive approver.

---

## Run the harness unit tests

The pure report/aggregate logic is covered by vitest. `evals/` is outside the
root workspace `projects` globs, so it uses its own config:

```bash
pnpm eval:test
# or: pnpm exec vitest run --config evals/vitest.config.ts
```

---

## How it's wired (and the one caveat)

The eval code imports the SDK from **source** (`packages/node-sdk/src`) via a
tsconfig `paths` mapping, so changes to the SDK / agent-core (including the
system prompt) are reflected immediately — important for catching prompt
regressions.

Running TypeScript source through `tsx` needs two shims that the build/test
pipelines normally provide, both installed by `framework/raw-text-loader.mjs`
(preloaded via `--import` in the `eval` script):

1. **Raw-text imports** — agent-core does `import desc from './grep.md'`. The
   loader resolves `.md` / `.yaml` to default-exported strings, mirroring
   `build/raw-text-plugin.mjs`. It uses Node's synchronous `module.registerHooks`
   (Node ≥ 22.15) because those files load through the sync CJS-interop path.
2. **A `require` shim** — `agent-core/src/utils/render-prompt.ts` lazily calls
   `require('nunjucks')`. The loader installs a `globalThis.require` rooted in
   the agent-core package so that single call resolves.

> If you ever see odd resolution errors, the SDK also ships a self-contained
> `dist/index.mjs`; you could repoint `evals/tsconfig.json`'s `paths` at it
> (and drop `--import`) to run against the built bundle instead of source.

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
  tsconfig.json                maps @lmcode-cli/lmcode-sdk → SDK source
  vitest.config.ts             standalone config for evals/**/*.test.ts
  framework/
    types.ts                   Task / ScoreResult / RunResult
    runner.ts                  drives one task via the SDK, scores the workdir
    report.ts                  pure table/aggregate formatting (unit-tested)
    report.test.ts             vitest for the pure report logic
    providers.ts               fake + real provider/model setup from env
    fake-provider.ts           keyless local OpenAI-compatible stub server
    raw-text-loader.mjs        tsx loader: .md/.yaml raw imports + require shim
    index.ts                   framework barrel
  tasks/
    smoke-plumbing.ts          keyless plumbing check (fake provider)
    fix-failing-fn.ts          real-model: fix a bug so the check passes
```
