/**
 * smoke-plumbing — PLUMBING ONLY. Runs without API keys.
 *
 * This task proves the harness wiring works end to end: a real
 * `@lmcode-cli/lmcode-sdk` session is created, driven against the keyless fake
 * provider (a local OpenAI-compatible stub), a turn completes, and the scorer
 * runs against the resulting workdir.
 *
 * IMPORTANT: a fake model emits a fixed string and cannot actually edit files,
 * so this CANNOT measure real agent quality. Its scorer therefore only asserts
 * a deterministic condition that the harness itself guarantees — that
 * `setup()` ran and the workdir is intact after the session turn. Treat a PASS
 * here as "the plumbing is healthy", nothing more. Real quality is measured by
 * `fix-failing-fn` (real-model).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Task } from '../framework';

const MARKER_FILE = 'PLUMBING_MARKER.txt';
const MARKER_CONTENT = 'lmcode-eval plumbing marker v1';

export const smokePlumbingTask: Task = {
  id: 'smoke-plumbing',
  description: 'Keyless harness plumbing check (fake provider — not a quality signal)',
  kind: 'fake',

  async setup(workdir: string): Promise<void> {
    await writeFile(join(workdir, MARKER_FILE), MARKER_CONTENT, 'utf-8');
  },

  prompt:
    'This is a plumbing smoke test. Reply with a short acknowledgement; no file changes are needed.',

  async score(workdir: string) {
    let content: string;
    try {
      content = await readFile(join(workdir, MARKER_FILE), 'utf-8');
    } catch (error) {
      return {
        passed: false,
        score: 0,
        details: `marker file missing after run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (content !== MARKER_CONTENT) {
      return {
        passed: false,
        score: 0,
        details: `marker file corrupted (got ${JSON.stringify(content)})`,
      };
    }

    return {
      passed: true,
      score: 1,
      details: 'harness ran setup → session turn → score; workdir intact (plumbing only)',
    };
  },
};
