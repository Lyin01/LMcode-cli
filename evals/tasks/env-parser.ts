/**
 * env-parser — REAL-MODEL eval (gated), greenfield-from-spec axis.
 *
 * The agent is given a written SPEC plus a stub and a *visible* test suite, and
 * must implement `parseEnv` / `validateEnv` in `src/env.mjs`. The scorer runs
 * the visible cases AND a set of HIDDEN cases that the agent never sees but that
 * follow directly from the SPEC. The split separates "implemented to the tests"
 * from "implemented to the spec" — the hidden pass-rate is the generalization
 * signal.
 *
 * Scoring (partial credit):
 *   score  = (visiblePass + hiddenPass) / (visibleTotal + hiddenTotal)
 *   passed = all VISIBLE cases pass (the acceptance tests the agent was shown).
 * So a model that nails the shown tests but misses a spec edge case reports
 * PASS with a sub-1.0 score — green in CI, but the tracked number shows the gap.
 *
 * Skipped automatically unless a real model is configured (see providers.ts).
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Task } from '../framework';

const SPEC_MD = `# Task: implement a dependency-free \`.env\` parser + validator

Implement the two exported functions in \`src/env.mjs\` so that **all tests pass**
(\`npm test\`). Use only Node built-ins — do NOT add dependencies.

## \`parseEnv(text, env = process.env) -> object\`

Parse \`text\` (the contents of a \`.env\` file) into a plain object of string
values. Rules, applied per line (lines split on \`\\n\`, tolerate \`\\r\\n\`):

1. A line is \`KEY=VALUE\`. Everything before the **first** \`=\` is the key,
   everything after is the raw value. (\`M=a=b=c\` -> value is \`a=b=c\`.)
2. Blank lines, and lines whose first non-space char is \`#\`, are ignored.
3. An optional leading \`export \` prefix on the key is stripped
   (\`export FOO=bar\` is the same as \`FOO=bar\`).
4. Surrounding whitespace around the key and around the value is trimmed.
5. A value may be wrapped in single (\`'\`) or double (\`"\`) quotes; the quotes are
   removed and the inner text is the value.
   - **Double-quoted**: process escapes \`\\n\` (newline), \`\\t\` (tab), \`\\\\\`
     (backslash), \`\\"\` (quote); then expand \`\${VAR}\` references (see rule 7).
   - **Single-quoted**: fully literal — no escape processing, no \`\${VAR}\`
     expansion.
6. **Inline comments**: in an *unquoted* value, a \`#\` that is preceded by
   whitespace starts a comment that is dropped (\`A=bar # note\` -> \`bar\`). A \`#\`
   not preceded by whitespace is part of the value (\`B=http://x#y\` ->
   \`http://x#y\`). Inside quotes, \`#\` is always literal.
7. **Interpolation**: \`\${NAME}\` in an unquoted or double-quoted value is replaced
   by the value of an **already-defined** key from this same parse, else by
   \`env[NAME]\`, else the empty string. (\`NAME\` matches \`[A-Za-z_][A-Za-z0-9_]*\`.)
8. A later duplicate key overrides an earlier one.
9. A non-blank, non-comment line with no \`=\` is invalid: throw an \`Error\` whose
   message includes the 1-based line number.

## \`validateEnv(parsed, schema) -> { ok, errors, values }\`

\`schema\` maps a key to \`{ required?: boolean, default?: string, oneOf?: string[] }\`.

- Start \`values\` as a shallow copy of \`parsed\`.
- For each schema key: if it is absent from \`parsed\` and a \`default\` is given,
  set \`values[key] = default\`.
- Collect an error string if a \`required\` key is still absent, or if a present
  value is not contained in a given \`oneOf\`.
- \`ok\` is \`true\` iff \`errors\` is empty.

Keep the public function names and signatures exactly as above.
`;

const STUB = `// Implement these two functions per SPEC.md. Use only Node built-ins.

export function parseEnv(text, env = process.env) {
  throw new Error('parseEnv not implemented');
}

export function validateEnv(parsed, schema) {
  throw new Error('validateEnv not implemented');
}
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'env-parser-task',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node test/run.mjs' },
  },
  null,
  2,
)}\n`;

const CASES_MJS = `// Visible test cases. Each case: { name, run(mod) } where \`mod\` is the
// module namespace from src/env.mjs. A case throws (via assert) on failure.
import assert from 'node:assert/strict';

export const visibleCases = [
  {
    name: 'parses simple KEY=VALUE',
    run: (m) => assert.deepEqual(m.parseEnv('A=1'), { A: '1' }),
  },
  {
    name: 'ignores blank lines and full-line comments',
    run: (m) => assert.deepEqual(m.parseEnv('# c\\n\\n   \\nB=2'), { B: '2' }),
  },
  {
    name: 'trims whitespace around key and value',
    run: (m) => assert.deepEqual(m.parseEnv('  C =  3  '), { C: '3' }),
  },
  {
    name: 'strips leading export prefix',
    run: (m) => assert.deepEqual(m.parseEnv('export D=4'), { D: '4' }),
  },
  {
    name: 'removes double quotes',
    run: (m) => assert.deepEqual(m.parseEnv('E="hello world"'), { E: 'hello world' }),
  },
  {
    name: 'removes single quotes',
    run: (m) => assert.deepEqual(m.parseEnv("F='hello'"), { F: 'hello' }),
  },
  {
    name: 'later duplicate key wins',
    run: (m) => assert.deepEqual(m.parseEnv('G=1\\nG=2'), { G: '2' }),
  },
  {
    name: 'value may contain equals signs',
    run: (m) => assert.deepEqual(m.parseEnv('M=a=b=c'), { M: 'a=b=c' }),
  },
  {
    name: 'throws with line number on a line missing =',
    run: (m) =>
      assert.throws(() => m.parseEnv('A=1\\noops'), (err) => /2/.test(String(err.message))),
  },
  {
    name: 'validateEnv reports a missing required key',
    run: (m) => {
      const r = m.validateEnv({}, { TOKEN: { required: true } });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => /TOKEN/.test(e)));
    },
  },
  {
    name: 'validateEnv applies a default for an absent key',
    run: (m) => {
      const r = m.validateEnv({}, { LEVEL: { default: 'info' } });
      assert.equal(r.ok, true);
      assert.equal(r.values.LEVEL, 'info');
    },
  },
  {
    name: 'validateEnv flags a value outside oneOf',
    run: (m) => {
      const r = m.validateEnv({ MODE: 'fast' }, { MODE: { oneOf: ['slow', 'medium'] } });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => /MODE/.test(e)));
    },
  },
];
`;

const RUN_MJS = `// Test runner: \`npm test\`. Runs the visible cases against src/env.mjs,
// prints a summary, and exits non-zero if any case fails.
import { visibleCases } from './cases.mjs';
import * as mod from '../src/env.mjs';

let pass = 0;
const failures = [];
for (const c of visibleCases) {
  try {
    c.run(mod);
    pass += 1;
  } catch (err) {
    failures.push(\`X \${c.name}: \${err.message}\`);
  }
}
for (const f of failures) console.error(f);
console.log(\`PASSED \${pass}/\${visibleCases.length}\`);
process.exit(failures.length === 0 ? 0 : 1);
`;

interface Case {
  readonly name: string;
  readonly run: (m: EnvModule) => void;
}

interface EnvModule {
  parseEnv(text: string, env?: Record<string, string | undefined>): Record<string, string>;
  validateEnv(
    parsed: Record<string, string>,
    schema: Record<string, { required?: boolean; default?: string; oneOf?: string[] }>,
  ): { ok: boolean; errors: string[]; values: Record<string, string> };
}

/**
 * Hidden cases — the agent never sees these. They follow directly from the SPEC
 * (no surprise rules), so a failure is a genuine generalization gap.
 */
const HIDDEN_CASES: readonly Case[] = [
  {
    name: 'inline comment after whitespace is dropped',
    run: (m) => assert.deepEqual(m.parseEnv('A=bar # note'), { A: 'bar' }),
  },
  {
    name: 'hash without preceding whitespace stays in the value',
    run: (m) => assert.deepEqual(m.parseEnv('B=http://x#y'), { B: 'http://x#y' }),
  },
  {
    name: 'hash inside double quotes is literal',
    run: (m) => assert.deepEqual(m.parseEnv('C="a # b"'), { C: 'a # b' }),
  },
  {
    name: 'double-quote escapes are processed',
    run: (m) => assert.deepEqual(m.parseEnv('D="line1\\nline2\\ttab"'), { D: 'line1\nline2\ttab' }),
  },
  {
    name: 'single-quoted escapes stay literal',
    run: (m) => assert.deepEqual(m.parseEnv("E='line1\\nline2'"), { E: 'line1\\nline2' }),
  },
  {
    name: 'interpolation uses an earlier key',
    run: (m) => assert.deepEqual(m.parseEnv('F=base\nG=${F}/sub'), { F: 'base', G: 'base/sub' }),
  },
  {
    name: 'interpolation works inside double quotes',
    run: (m) => assert.deepEqual(m.parseEnv('F=base\nH="${F}!"'), { F: 'base', H: 'base!' }),
  },
  {
    name: 'no interpolation inside single quotes',
    run: (m) => assert.deepEqual(m.parseEnv("I='${HOME}'"), { I: '${HOME}' }),
  },
  {
    name: 'export + double quotes + inline comment combine',
    run: (m) => assert.deepEqual(m.parseEnv('export J="v" # trailing'), { J: 'v' }),
  },
  {
    name: 'interpolation falls back to the env argument',
    run: (m) => assert.deepEqual(m.parseEnv('K=${Z}', { Z: 'zz' }), { K: 'zz' }),
  },
  {
    name: 'unknown interpolation becomes empty string',
    run: (m) => assert.deepEqual(m.parseEnv('L=${NOPE}x', {}), { L: 'x' }),
  },
  {
    name: 'empty value yields empty string',
    run: (m) => assert.deepEqual(m.parseEnv('N='), { N: '' }),
  },
  {
    name: 'validateEnv passes a value present in oneOf and copies others',
    run: (m) => {
      const r = m.validateEnv({ MODE: 'slow', EXTRA: 'k' }, { MODE: { oneOf: ['slow', 'fast'] } });
      assert.equal(r.ok, true);
      assert.equal(r.values.MODE, 'slow');
      assert.equal(r.values.EXTRA, 'k');
    },
  },
  {
    name: 'validateEnv does not override a present value with its default',
    run: (m) => {
      const r = m.validateEnv({ LEVEL: 'debug' }, { LEVEL: { default: 'info' } });
      assert.equal(r.values.LEVEL, 'debug');
    },
  },
];

function runCases(
  cases: readonly Case[],
  mod: EnvModule,
): { pass: number; total: number; failures: string[] } {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      c.run(mod);
      pass += 1;
    } catch (err) {
      failures.push(`${c.name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  return { pass, total: cases.length, failures };
}

export const envParserTask: Task = {
  id: 'env-parser',
  description: 'Implement a .env parser from a spec; scored on visible + hidden cases (real model)',
  kind: 'real',
  // The implementation is ~100 lines; a small model needs headroom over the 2-min default.
  turnTimeoutMs: 360_000,

  async setup(workdir: string): Promise<void> {
    await mkdir(join(workdir, 'src'), { recursive: true });
    await mkdir(join(workdir, 'test'), { recursive: true });
    await writeFile(join(workdir, 'SPEC.md'), SPEC_MD, 'utf-8');
    await writeFile(join(workdir, 'package.json'), PACKAGE_JSON, 'utf-8');
    await writeFile(join(workdir, 'src', 'env.mjs'), STUB, 'utf-8');
    await writeFile(join(workdir, 'test', 'cases.mjs'), CASES_MJS, 'utf-8');
    await writeFile(join(workdir, 'test', 'run.mjs'), RUN_MJS, 'utf-8');
  },

  prompt: [
    'Read SPEC.md and implement the two functions in src/env.mjs so that `npm test`',
    'passes. Use only Node built-ins; do not add dependencies. Verify by running the',
    'tests yourself before finishing. Do not edit anything under test/.',
  ].join(' '),

  async score(workdir: string) {
    let mod: EnvModule;
    try {
      mod = (await import(pathToFileURL(join(workdir, 'src', 'env.mjs')).href)) as EnvModule;
    } catch (err) {
      return {
        passed: false,
        score: 0,
        details: `failed to import src/env.mjs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Visible cases come from the (trusted-not-cheated, like fix-failing-fn) workdir
    // file; hidden cases are authoritative and inline.
    let visible = { pass: 0, total: 0, failures: [] as string[] };
    try {
      const { visibleCases } = (await import(
        pathToFileURL(join(workdir, 'test', 'cases.mjs')).href
      )) as { visibleCases: Case[] };
      visible = runCases(visibleCases, mod);
    } catch (err) {
      visible.failures.push(`could not load visible cases: ${err instanceof Error ? err.message : String(err)}`);
    }

    const hidden = runCases(HIDDEN_CASES, mod);

    const pass = visible.pass + hidden.pass;
    const total = visible.total + hidden.total;
    const score = total === 0 ? 0 : pass / total;
    const passed = visible.total > 0 && visible.pass === visible.total;

    const missed = hidden.failures.length > 0 ? ` | hidden misses: ${hidden.failures.join('; ')}` : '';
    return {
      passed,
      score,
      details: `visible ${visible.pass}/${visible.total}, hidden ${hidden.pass}/${hidden.total} (combined ${pass}/${total})${missed}`,
    };
  },
};
