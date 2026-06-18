/**
 * LMcode rename round 3 — fix import paths and remaining identifiers.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store']);

const ROUND3 = [
  // Fix import paths that reference renamed files
  [`#/tui/lmcode-tui`, `#/tui/lmcode-tui`],
  [`#/tui/constant/lmcode-tui`, `#/tui/constant/lmcode-tui`],
  [`./lmcode-tui`, `./lmcode-tui`],
  [`'./lmcode-tui`, `'./lmcode-tui`],
  
  // Env var string values
  [`'LMCODE_HOME'`, `'LMCODE_HOME'`],
  [`"LMCODE_HOME"`, `"LMCODE_HOME"`],
  [`LMCODE_HOME`, `LMCODE_HOME`],
  [`'LMCODE_MODEL_`, `'LMCODE_MODEL_`],
  [`LMCODE_MODEL_`, `LMCODE_MODEL_`],
  
  // Internal config property names
  [`lmcodeConfig`, `lmcodeConfig`],
  [`lmcodeRequestHeaders`, `lmcodeRequestHeaders`],
  [`lmcodeVersion`, `lmcodeVersion`],
  [`lmcodeBuiltInCatalog`, `lmcodeBuiltInCatalog`],
  
  // Plugin manifest file names  
  [`lmcode.plugin.json`, `lmcode.plugin.json`],
  [`.lmcode-plugin/`, `.lmcode-plugin/`],
  [`'lmcode-plugin-root'`, `'lmcode-plugin-root'`],
  [`'lmcode-plugin-dir'`, `'lmcode-plugin-dir'`],
  
  // Test mock variable names
  [`lmcodeHarnessConstructor`, `lmcodeHarnessConstructor`],
  [`lmcodeTuiConstructor`, `lmcodeTuiConstructor`],
  
  // Plugin names in marketplace/tests
  [`lmcode-datasource`, `lmcode-datasource`],
  
  // Provider type string ,
  [`,`], // will be replaced contextually, but let's be careful
  
  // CLI command in strings/docs: "scream " → "lm "
  [`lm -r`, `lm -r`],
  [`lm --version`, `lm --version`],
  [`lm -S`, `lm -S`],
  [`lm -C`, `lm -C`],
  [`lm -y`, `lm -y`],
  [`lm stream-json`, `lm stream-json`],
  [`lm channel`, `lm channel`],
  [`lm export`, `lm export`],
  [`lm config`, `lm config`],
  [`lm-resume`, `lm-resume`],
  
  // Symlink/shim paths
  [`~/.lmcode/bin/lm`, `~/.lmcode/bin/lm`],
  
  // Legacy env in test files
  [`__lmcode_`, `__lmcode_`],
  
  // Model names in provider
  [`'lmcode-k2`, `'lmcode-k2`],
  [`'lmcode-for-coding`, `'lmcode-for-coding`],
  [`lmcode-k2-5`, `lmcode-k2-5`],
  [`lmcode-thinking`, `lmcode-thinking`],
  [`lmcode-plain`, `lmcode-plain`],
  [`lmcode-cli-v1`, `lmcode-cli-v1`],
  
  // Remaining `.scream` references (config dirs in test fixtures except migration)
  [`.lmcode/`, `.lmcode/`],
  [`~/.lmcode/config`, `~/.lmcode/config`],
  
  // Postinstall UI strings
  [`old lmcode`, `old lmcode`],
  [`the new lmcode`, `the new lmcode`],
  [`switch to the new lmcode`, `switch to the new lmcode`],
  [`new lmcode`, `new lmcode`],
  [`renamed your old lmcode`, `renamed your old lmcode`],
  
  // Channel setup binary detection  
  [`"which lm`, `"which lm`],
  [`"where lm`, `"where lm`],
  [`return "lm stream-json"`, `return "lm stream-json"`],
  
  // Temp dir patterns
  [`lmcode-e2e`, `lmcode-e2e`],
  [`lmcode-edit-`, `lmcode-edit-`],
  [`lmcode-wsl-`, `lmcode-wsl-`],
  [`lmcode-update-`, `lmcode-update-`],
  [`lmcode-export-`, `lmcode-export-`],
  [`lmcode-persistence-`, `lmcode-persistence-`],
  [`lmcode-plugin-`, `lmcode-plugin-`],
  [`lmcode-built-in-`, `lmcode-built-in-`],
  [`lmcode-tui-`, `lmcode-tui-`],
  [`lmcode-home`, `lmcode-home`],
  [`lmcode-test`, `lmcode-test`],
  [`lmcode-plan`, `lmcode-plan`],
  [`lmcode-cli-log-`, `lmcode-cli-log-`],
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
      if (['.ts','.tsx','.mjs','.js','.json','.md','.yaml','.yml','.sh','.ps1','.html','.toml'].includes(ext) ||
          entry.name === 'AGENTS.md' || entry.name === 'README.md' || entry.name === 'CONTRIBUTING.md' ||
          entry.name === '.gitignore' || entry.name === 'package.json' || entry.name === 'config.json') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

console.log('Round 3 replacements (import paths + identifiers)...');
const allFiles = walk(ROOT);
const files = allFiles.filter(f => 
  !f.includes('node_modules') && 
  !f.includes('.git/') && 
  !f.includes('/dist/') &&
  !f.includes('migration-legacy/test/fixtures/') // skip migration fixtures
);
console.log(`Processing ${files.length} files...`);

let changed = 0;
for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { continue; }
  const original = content;
  for (const [search, replace] of ROUND3) {
    if (content.includes(search)) {
      content = content.split(search).join(replace);
    }
  }
  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    changed++;
    console.log(`  ✓ ${relative(ROOT, file)}`);
  }
}
console.log(`\nRound 3 done. ${changed} files changed.`);
