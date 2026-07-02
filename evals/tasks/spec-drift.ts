/**
 * spec-drift — REAL-MODEL eval (gated).
 *
 * Measures spec consistency: the prompt is one natural paragraph that embeds
 * five explicit, independently-checkable requirements — including the classic
 * drift victims (a second file, an edge-case rule buried mid-sentence). Agents
 * routinely satisfy the headline ask and silently drop one or two details;
 * this task scores detail coverage with partial credit (each requirement is
 * worth 0.2) so regressions in spec adherence show up as a number.
 *
 * Requirements checked on disk:
 *   1. src/slugify.mjs exports slugify() with basic lowercase-hyphen behavior
 *   2. leading/trailing whitespace is trimmed before slugifying
 *   3. consecutive separators collapse into a single hyphen
 *   4. optional maxLength truncates without leaving a trailing hyphen
 *   5. docs/USAGE.md exists with a usage example
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Task } from '../framework';

/** Scorer-owned probe script, written into the workdir at scoring time.
 *  Prints one JSON object with a boolean per functional requirement. */
const CHECK_SCRIPT = `const results = {
  basic: false,
  trims: false,
  collapses: false,
  maxLength: false,
};
try {
  const mod = await import('./src/slugify.mjs');
  const slugify = mod.slugify;
  if (typeof slugify === 'function') {
    results.basic = slugify('Hello World') === 'hello-world';
    results.trims = slugify('  Hello World  ') === 'hello-world';
    results.collapses = slugify('a   b--c') === 'a-b-c';
    try {
      results.maxLength =
        slugify('hello world', 7) === 'hello-w' &&
        slugify('hello world', 6) === 'hello';
    } catch {
      results.maxLength = false;
    }
  }
} catch {
  // Missing or broken module: all requirements stay false.
}
console.log(JSON.stringify(results));
`;

const CHECK_FILE = '.eval-spec-drift-check.mjs';

interface CheckResults {
  readonly basic: boolean;
  readonly trims: boolean;
  readonly collapses: boolean;
  readonly maxLength: boolean;
}

function runNode(workdir: string, script: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('error', (err) => resolve({ code: 1, output: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

export const specDriftTask: Task = {
  id: 'spec-drift',
  description: 'Agent satisfies ALL five embedded spec details, scored by coverage (real model)',
  kind: 'real',

  async setup(): Promise<void> {
    // Intentionally empty workdir: everything must come from the prompt.
  },

  prompt: [
    'Create a tiny dependency-free ESM utility in this project: src/slugify.mjs',
    'exporting a function slugify(text, maxLength). It should lowercase the text',
    'and replace runs of spaces and punctuation with single hyphens — make sure',
    'consecutive separators collapse into one hyphen, and trim leading/trailing',
    'whitespace away before slugifying. When maxLength is provided, truncate the',
    'slug to at most that many characters, and never leave a trailing hyphen',
    'after truncating. Also add a short docs/USAGE.md with at least one usage',
    'example. Keep everything plain ESM with no dependencies.',
  ].join(' '),

  turnTimeoutMs: 300_000,

  async score(workdir: string) {
    await writeFile(join(workdir, CHECK_FILE), CHECK_SCRIPT, 'utf-8');
    const { output } = await runNode(workdir, CHECK_FILE);

    let checks: CheckResults = { basic: false, trims: false, collapses: false, maxLength: false };
    try {
      const lastLine = output.split('\n').at(-1) ?? '';
      checks = { ...checks, ...(JSON.parse(lastLine) as Partial<CheckResults>) };
    } catch {
      // Unparseable probe output: functional requirements stay false.
    }

    let usageDoc = false;
    try {
      const doc = await readFile(join(workdir, 'docs', 'USAGE.md'), 'utf-8');
      usageDoc = doc.includes('slugify');
    } catch {
      usageDoc = false;
    }

    const requirements: readonly [string, boolean][] = [
      ['slugify() basic lowercase-hyphen behavior', checks.basic],
      ['trims surrounding whitespace first', checks.trims],
      ['collapses consecutive separators', checks.collapses],
      ['maxLength truncation without trailing hyphen', checks.maxLength],
      ['docs/USAGE.md with a usage example', usageDoc],
    ];
    const passedCount = requirements.filter(([, ok]) => ok).length;
    const score = passedCount / requirements.length;
    const details = requirements
      .map(([label, ok]) => `${ok ? '✓' : '✗'} ${label}`)
      .join('; ');

    return {
      passed: passedCount === requirements.length,
      score,
      details: `${String(passedCount)}/${String(requirements.length)} spec details met — ${details}`,
    };
  },
};
