/**
 * Fix round 3 bug: restore 'scream' → 'lmcode' in all corrupted files.
 * The buggy entry ["'scream'"] (missing replacement value) deleted 'scream' everywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = 'E:/project for cc/lmcode';

// Find all files with the corruption patterns
const patterns = [
  [`type: 'lmcode',`, `type: 'lmcode',`],
  [`type: 'lmcode'`, `type: 'lmcode'`],
  [`case 'lmcode':`, `case 'lmcode':`],
  [`providers['lmcode']`, `providers['lmcode']`],
  [`providers[ , ]`, `providers['lmcode']`],
];

// Use grep to find affected files
let files = new Set();
for (const [search] of patterns) {
  try {
    const result = execSync(
      `grep -rl "${search.replace(/'/g, `'\\''`)}" --include="*.ts" --include="*.tsx" --include="*.mjs" "${ROOT}/packages" "${ROOT}/apps" 2>/dev/null`,
      { encoding: 'utf-8', shell: '/usr/bin/bash' }
    );
    for (const line of result.trim().split('\n')) {
      if (line && !line.includes('node_modules') && !line.includes('.git/')) {
        files.add(line);
      }
    }
  } catch { /* no matches */ }
}

console.log(`Found ${files.size} files with corruption. Fixing...`);

for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { continue; }
  const original = content;
  for (const [search, replace] of patterns) {
    content = content.split(search).join(replace);
  }
  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    console.log(`  ✓ ${file.replace(ROOT + '/', '')}`);
  }
}
console.log('Done fixing round 3 bug.');
