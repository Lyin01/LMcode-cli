/**
 * expr-eval — REAL-MODEL eval (gated), deep-reasoning axis.
 *
 * Implement a recursive-descent arithmetic evaluator from a written SPEC. The
 * point of this task is *precedence/associativity reasoning*, not breadth: the
 * hidden cases concentrate on the classic traps (right-associative `^`, unary
 * minus binding looser than `^`, an exponent that is itself a unary expression,
 * left-associative `%`/`/`). These are exactly where a weaker model slips, so
 * this task discriminates between models that the parser/debug tasks max out.
 *
 * Scoring mirrors env-parser: partial credit, `passed` gated on the visible
 * cases, hidden pass-rate is the reasoning signal. Skipped without a real model.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Task } from '../framework';

const SPEC_MD = `# Task: implement an arithmetic expression evaluator

Implement \`evaluate(expr)\` in \`src/expr.mjs\` so that \`npm test\` passes. Use only
Node built-ins; do NOT add dependencies.

## \`evaluate(expr: string) -> number\`

Evaluate a single arithmetic expression string and return its numeric value.

### Tokens
- Non-negative number literals: \`\\d+\` or \`\\d+.\\d+\` (e.g. \`3\`, \`3.5\`). No
  scientific notation. (Negative numbers arise from the unary \`-\` operator.)
- Binary operators: \`+\` \`-\` \`*\` \`/\` \`%\` \`^\`.
- Prefix unary operators: \`+\` and \`-\`.
- Parentheses \`(\` \`)\`.
- Whitespace between tokens is insignificant.

### Precedence and associativity (lowest → highest)
1. \`+\` \`-\` (binary) — **left**-associative.
2. \`*\` \`/\` \`%\` — **left**-associative. (\`/\` is real division: \`7/2 == 3.5\`.
   \`%\` is JS remainder.)
3. unary \`-\` / \`+\` (prefix).
4. \`^\` (power, \`Math.pow\`) — **right**-associative; its right operand may itself
   be a unary expression.
5. atoms: a number, or \`( expr )\`.

Because unary binds **looser** than \`^\`, and \`^\` is right-associative and takes a
unary right operand, the following must hold:

| Expression | Result | Why |
|------------|--------|-----|
| \`2+3*4\`     | 14   | \`*\` before \`+\` |
| \`10-2-3\`    | 5    | \`-\` is left-associative |
| \`2^3^2\`     | 512  | \`^\` is right-associative: \`2^(3^2)\` |
| \`-3^2\`      | -9   | unary looser than \`^\`: \`-(3^2)\` |
| \`2^-3\`      | 0.125| exponent may be unary: \`2^(-3)\` |
| \`2*3^2\`     | 18   | \`^\` before \`*\` |
| \`10%4%2\`    | 0    | \`%\` left-associative: \`(10%4)%2\` |

### Errors
Throw an \`Error\` for any malformed input: an empty/blank string, an unknown
character, a missing operand (e.g. \`1+\`, \`*5\`), unbalanced parentheses (e.g.
\`(1\`), or trailing/leftover input (e.g. \`1 2\`).

Keep the public function name and signature exactly as above.
`;

const STUB = `// Implement evaluate(expr) per SPEC.md. Use only Node built-ins.

export function evaluate(expr) {
  throw new Error('evaluate not implemented');
}
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'expr-eval-task',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node test/run.mjs' },
  },
  null,
  2,
)}\n`;

const CASES_MJS = `// Visible test cases for src/expr.mjs. Each case: { name, run(mod) }.
import assert from 'node:assert/strict';

const eq = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, \`got \${actual}, want \${expected}\`);

export const visibleCases = [
  { name: '2+3*4 = 14', run: (m) => eq(m.evaluate('2+3*4'), 14) },
  { name: '(2+3)*4 = 20', run: (m) => eq(m.evaluate('(2+3)*4'), 20) },
  { name: '10-2-3 = 5 (left assoc)', run: (m) => eq(m.evaluate('10-2-3'), 5) },
  { name: '2*3+4*5 = 26', run: (m) => eq(m.evaluate('2*3+4*5'), 26) },
  { name: '7/2 = 3.5 (real division)', run: (m) => eq(m.evaluate('7/2'), 3.5) },
  { name: '2^10 = 1024', run: (m) => eq(m.evaluate('2^10'), 1024) },
  { name: '-5+3 = -2 (unary)', run: (m) => eq(m.evaluate('-5+3'), -2) },
  { name: '2*-3 = -6 (unary after operator)', run: (m) => eq(m.evaluate('2*-3'), -6) },
  { name: 'whitespace insignificant', run: (m) => eq(m.evaluate('  ( 1 + 2 ) * 3 '), 9) },
  { name: '3.5*2 = 7 (decimals)', run: (m) => eq(m.evaluate('3.5*2'), 7) },
  { name: 'throws on a missing operand (1+)', run: (m) => assert.throws(() => m.evaluate('1+')) },
  { name: 'throws on unbalanced parens ((1)', run: (m) => assert.throws(() => m.evaluate('(1')) },
];
`;

const RUN_MJS = `// Test runner: \`npm test\`. Runs visible cases against src/expr.mjs.
import { visibleCases } from './cases.mjs';
import * as mod from '../src/expr.mjs';

let pass = 0;
const failures = [];
for (const c of visibleCases) {
  try { c.run(mod); pass += 1; }
  catch (err) { failures.push(\`X \${c.name}: \${err.message}\`); }
}
for (const f of failures) console.error(f);
console.log(\`PASSED \${pass}/\${visibleCases.length}\`);
process.exit(failures.length === 0 ? 0 : 1);
`;

interface ExprModule {
  evaluate(expr: string): number;
}

interface Case {
  readonly name: string;
  readonly run: (m: ExprModule) => void;
}

const eq = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `got ${actual}, want ${expected}`);

/**
 * Hidden cases — never shown to the agent. They follow directly from the SPEC's
 * precedence table (no surprise rules); the hidden pass-rate is the reasoning
 * signal that separates models the easier tasks max out.
 */
const HIDDEN_CASES: readonly Case[] = [
  { name: '2^3^2 = 512 (right associative)', run: (m) => eq(m.evaluate('2^3^2'), 512) },
  { name: '-3^2 = -9 (unary looser than ^)', run: (m) => eq(m.evaluate('-3^2'), -9) },
  { name: '2^-3 = 0.125 (unary exponent)', run: (m) => eq(m.evaluate('2^-3'), 0.125) },
  { name: '2^2^3 = 256 (right associative)', run: (m) => eq(m.evaluate('2^2^3'), 256) },
  { name: '7%3 = 1', run: (m) => eq(m.evaluate('7%3'), 1) },
  { name: '2+3%2 = 3 (% over +)', run: (m) => eq(m.evaluate('2+3%2'), 3) },
  { name: '100/5/2 = 10 (left assoc)', run: (m) => eq(m.evaluate('100/5/2'), 10) },
  { name: '((2+3)*(4-1)) = 15', run: (m) => eq(m.evaluate('((2+3)*(4-1))'), 15) },
  { name: '-(3+4) = -7 (unary on parens)', run: (m) => eq(m.evaluate('-(3+4)'), -7) },
  { name: '2*3^2 = 18 (^ over *)', run: (m) => eq(m.evaluate('2*3^2'), 18) },
  { name: '10%4%2 = 0 (left assoc)', run: (m) => eq(m.evaluate('10%4%2'), 0) },
  { name: '1++2 = 3 (unary plus)', run: (m) => eq(m.evaluate('1++2'), 3) },
  { name: 'throws on leading operator (*5)', run: (m) => assert.throws(() => m.evaluate('*5')) },
  { name: 'throws on juxtaposed numbers (1 2)', run: (m) => assert.throws(() => m.evaluate('1 2')) },
  { name: 'throws on empty input', run: (m) => assert.throws(() => m.evaluate('   ')) },
  { name: 'throws on undefined operator (2**3)', run: (m) => assert.throws(() => m.evaluate('2**3')) },
];

function runCases(cases: readonly Case[], mod: ExprModule): { pass: number; total: number; failures: string[] } {
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

export const exprEvalTask: Task = {
  id: 'expr-eval',
  description: 'Implement a precedence-correct expression evaluator; visible + hidden scoring (real model)',
  kind: 'real',
  turnTimeoutMs: 360_000,

  async setup(workdir: string): Promise<void> {
    await mkdir(join(workdir, 'src'), { recursive: true });
    await mkdir(join(workdir, 'test'), { recursive: true });
    await writeFile(join(workdir, 'SPEC.md'), SPEC_MD, 'utf-8');
    await writeFile(join(workdir, 'package.json'), PACKAGE_JSON, 'utf-8');
    await writeFile(join(workdir, 'src', 'expr.mjs'), STUB, 'utf-8');
    await writeFile(join(workdir, 'test', 'cases.mjs'), CASES_MJS, 'utf-8');
    await writeFile(join(workdir, 'test', 'run.mjs'), RUN_MJS, 'utf-8');
  },

  prompt: [
    'Read SPEC.md and implement evaluate(expr) in src/expr.mjs so that `npm test`',
    'passes. Pay close attention to the precedence and associativity table. Use only',
    'Node built-ins; do not add dependencies. Verify by running the tests yourself',
    'before finishing. Do not edit anything under test/.',
  ].join(' '),

  async score(workdir: string) {
    let mod: ExprModule;
    try {
      mod = (await import(pathToFileURL(join(workdir, 'src', 'expr.mjs')).href)) as ExprModule;
    } catch (err) {
      return {
        passed: false,
        score: 0,
        details: `failed to import src/expr.mjs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

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
