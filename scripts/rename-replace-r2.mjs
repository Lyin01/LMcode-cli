/**
 * LMcode rename round 2 — catch remaining "lm" references.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store']);

const ROUND2 = [
  // CLI command in docs/CI: "lm --version" etc.
  [/\bscream --/g, 'lm --'],
  // standalone "lm" command in backticks
  [/`lm`/g, '`lm`'],
  // lmcode as product/repo name (already mostly done but catch stragglers)
  [/\bscream-code-built-in-catalog\b/g, 'lmcode-built-in-catalog'],
  [/\bscream-code-native\b/g, 'lmcode-native'],
  [/\bscream-code-/g, 'lmcode-'],
  [/\bscream-code\b/g, 'lmcode'],
  // .lmcode as config dir (only in text, the string literal was already handled)
  [/\.lmcode\b/g, '.lmcode'],
  // Scream* in AGENTS.md section headers  
  [/\bScreamTUI\b/g, 'LmcodeTUI'],
  [/\bscream-tui\.ts\b/g, 'lmcode-tui.ts'],
  [/\bscreamHomeDir\b/g, 'lmcodeHomeDir'],
  [/\b@scream-cli\//g, '@lmcode-cli/'],
  [/\b@lmcode\//g, '@lmcode/'],
  // LMCODE_HOME env var value (string)
  [/'LMCODE_HOME'/g, "'LMCODE_HOME'"],
  // "lm" in keywords arrays
  [/\"scream\"/g, '"lm"'],
  // Scream in oauth provider references
  [/\bScream auth\b/g, 'LMcode auth'],
  [/\bScream identity\b/g, 'LMcode identity'],
  // "LMcode" (mixed case)
  [/\bscream Code\b/g, 'LMcode'],
  // provider class references in comments  
  [/\bScreamChatProvider\b/g, 'LmcodeChatProvider'],
  [/\bScreamFiles\b/g, 'LmcodeFiles'],
  [/\bScreamHarness\b/g, 'LmcodeHarness'],
];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (['.ts','.tsx','.mjs','.js','.json','.md','.yaml','.yml','.sh','.ps1','.html','.toml','.txt'].includes(ext) ||
          entry.name === 'AGENTS.md' || entry.name === 'README.md' || entry.name === 'CONTRIBUTING.md' ||
          entry.name === '.gitignore' || entry.name === 'package.json') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

console.log('Round 2 replacements...');
const files = walk(ROOT).filter(f => !f.includes('node_modules') && !f.includes('.git/') && !f.includes('/dist/'));
console.log(`Processing ${files.length} files...`);

let changed = 0;
for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { continue; }
  const original = content;
  for (const [pattern, replacement] of ROUND2) {
    content = content.replace(pattern, replacement);
  }
  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    changed++;
    console.log(`  ✓ ${relative(ROOT, file)}`);
  }
}
console.log(`\nRound 2 done. ${changed} files changed.`);
