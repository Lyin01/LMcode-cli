import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const TUI_ROOT = join(__dirname, '..', '..', 'src', 'tui');
const RAW_NAMED_CHALK =
  /\bchalk\.(dim|white|cyan|red|green|gray|yellow|blue|magenta|whiteBright|blackBright)\b/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('TUI theme chalk guard', () => {
  it('keeps render code on semantic theme colors instead of raw chalk names', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];
    for (const file of walk(TUI_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const trimmed = line.trimStart();
        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }
        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlockComment = true;
          continue;
        }
        if (trimmed.startsWith('//')) continue;

        RAW_NAMED_CHALK.lastIndex = 0;
        if (RAW_NAMED_CHALK.test(line)) {
          offenders.push({
            file: file.slice(file.indexOf('src/')),
            line: i + 1,
            snippet: trimmed,
          });
        }
      }
    }

    expect(
      offenders,
      `Use theme colors/styles instead of raw named chalk helpers in TUI render paths.\n` +
        offenders.map((o) => `  ${o.file}:${String(o.line)}  ${o.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
