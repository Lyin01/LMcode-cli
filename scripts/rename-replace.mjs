/**
 * LMcode rename script — bulk content replacement across the entire project.
 * Run from project root: node scripts/rename-replace.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store']);

// Files to skip entirely
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'dream-lock.json']);

// Only process these extensions (plus package.json, .toml, .yaml, .md, .sh, .ps1, .mjs, no-ext files)
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.toml',
  '.yaml', '.yml', '.sh', '.ps1', '.txt', '.html', '.css', '.svg',
  '.gitignore', '.npmignore', '.editorconfig', '.prettierrc',
]);

// Ordered replacements: apply from top to bottom.
// LONGER / more-specific patterns first to avoid partial-match damage.
const REPLACEMENTS = [
  // ── Round 1: SCREAM_CODE_* constants (most specific) ──
  [`LMCODE_HOME_ENV`, `LMCODE_HOME_ENV`],
  [`LMCODE_DATA_DIR_NAME = '.lmcode'`, `LMCODE_DATA_DIR_NAME = '.lmcode'`],
  [`LMCODE_DATA_DIR_NAME`, `LMCODE_DATA_DIR_NAME`],
  [`LMCODE_LOG_DIR_NAME`, `LMCODE_LOG_DIR_NAME`],
  [`LMCODE_UPDATE_DIR_NAME`, `LMCODE_UPDATE_DIR_NAME`],
  [`LMCODE_UPDATE_STATE_FILE_NAME`, `LMCODE_UPDATE_STATE_FILE_NAME`],
  [`LMCODE_GITHUB_REPO`, `LMCODE_GITHUB_REPO`],
  [`LMCODE_CDN_LATEST_URL`, `LMCODE_CDN_LATEST_URL`],
  [`LMCODE_PLUGIN_MARKETPLACE_URL_ENV`, `LMCODE_PLUGIN_MARKETPLACE_URL_ENV`],
  [`LMCODE_PLUGIN_MARKETPLACE_URL`, `LMCODE_PLUGIN_MARKETPLACE_URL`],
  [`LMCODE_PLATFORM`, `LMCODE_PLATFORM`],
  [`LMCODE_API_KEY`, `LMCODE_API_KEY`],
  [`LMCODE_BASE_URL`, `LMCODE_BASE_URL`],
  [`LMCODE_E2E_REAL`, `LMCODE_E2E_REAL`],
  [`LMCODE_E2E`, `LMCODE_E2E`],
  // LMCODE_HOME last (shorter, but after the more specific ones)
  [`LMCODE_HOME`, `LMCODE_HOME`],

  // ── Round 1b: string literals ──
  [`'.lmcode'`, `'.lmcode'`],
  [`"lmcode_cli"`, `"lmcode_cli"`],
  [`'lmcode_cli'`, `'lmcode_cli'`],

  // ── Round 2: Class / interface / type names ──
  [`LmcodeChatProvider`, `LmcodeChatProvider`],
  [`LmcodeStreamedMessage`, `LmcodeStreamedMessage`],
  [`LmcodeFiles`, `LmcodeFiles`],
  [`LmcodeFilePurpose`, `LmcodeFilePurpose`],
  [`LmcodeOptions`, `LmcodeOptions`],
  [`LmcodeHarness`, `LmcodeHarness`],
  [`LmcodeAuthFacade`, `LmcodeAuthFacade`],
  [`LmcodeError`, `LmcodeError`],
  [`LmcodeTUIState`, `LmcodeTUIState`],
  [`LmcodeTUI`, `LmcodeTUI`],
  [`LmcodeHostIdentity`, `LmcodeHostIdentity`],
  [`LmcodeIdentityOptions`, `LmcodeIdentityOptions`],
  [`createLmcodeDeviceId`, `createLmcodeDeviceId`],
  [`createLmcodeDeviceHeaders`, `createLmcodeDeviceHeaders`],
  [`createLmcodeUserAgent`, `createLmcodeUserAgent`],
  [`createLmcodeDefaultHeaders`, `createLmcodeDefaultHeaders`],
  [`assertLmcodeHostIdentity`, `assertLmcodeHostIdentity`],
  [`normalizeLmcodeToolSchema`, `normalizeLmcodeToolSchema`],
  [`resolveLmcodeHome`, `resolveLmcodeHome`],

  // ── Round 2b: Product brand strings ──
  [`LMcode`, `LMcode`],

  // ── Round 3: Package scope names ──
  [`@lmcode-cli/agent-core`, `@lmcode-cli/agent-core`],
  [`@lmcode-cli/lmcode-sdk`, `@lmcode-cli/lmcode-sdk`],
  [`@lmcode-cli/config`, `@lmcode-cli/config`],
  [`@lmcode-cli/ltod`, `@lmcode-cli/ltod`],
  [`@lmcode-cli/jian`, `@lmcode-cli/jian`],
  [`@lmcode-cli/migration-legacy`, `@lmcode-cli/migration-legacy`],
  [`@lmcode-cli/monorepo`, `@lmcode-cli/monorepo`],
  [`@lmcode/memory`, `@lmcode/memory`],
  [`@lmcode-cli/lmcode`, `@lmcode-cli/lmcode`],

  // ── Round 3b: Path references ──
  [`apps/lmcode`, `apps/lmcode`],

  // ── Round 4: Binary command & CLI identifiers ──
  [`CLI_COMMAND_NAME = 'lm'`, `CLI_COMMAND_NAME = 'lm'`],
  [`"bin": { "lm"`, `"bin": { "lm"`],
  [`"bin":{"lm"`, `"bin":{"lm"`],
  [`'lmcode-cli'`, `'lmcode-cli'`],
  [`"lmcode-cli"`, `"lmcode-cli"`],
  [`'managed:lmcode'`, `'managed:lmcode'`],
  [`"managed:lmcode"`, `"managed:lmcode"`],
  [`'lmcode-'`, `'lmcode-'`],
  [`"lmcode-"`, `"lmcode-"`],

  // ── Round 4b: Provider name ──
  [`name: 'lmcode'`, `name: 'lmcode'`],
  [`name: "lmcode"`, `name: "lmcode"`],
  [`name: string = 'lmcode'`, `name: string = 'lmcode'`],

  // ── Round 4c: Model names ──
  [`lmcode-k2.6`, `lmcode-k2.6`],
  [`lmcode-for-coding`, `lmcode-for-coding`],

  // ── Round 4d: Install paths ──
  [`~/.lmcode/bin/lm`, `~/.lmcode/bin/lm`],
  [`.lmcode/bin/lm`, `.lmcode/bin/lm`],
  [`LMCODE_HOME:-$HOME/.lmcode`, `LMCODE_HOME:-$HOME/.lmcode`],

  // ── Round 5: Remaining references in docs / comments ──
  // "lmcode" as package/product name → "lmcode"
  [`"lmcode"`, `"lmcode"`],
  // "lm" as CLI name in docs (context-specific, safer at end)
  // We handle this very carefully below
];

// Files that refer to the OLD legacy system (migration fixtures) — skip these
const MIGRATION_FIXTURE_GLOBS = [
  'packages/migration-legacy/test/fixtures/',
];

function shouldSkip(filePath) {
  const rel = relative(ROOT, filePath);
  for (const pattern of MIGRATION_FIXTURE_GLOBS) {
    if (rel.startsWith(pattern)) return true;
  }
  const base = rel.split(/[\\/]/).pop();
  if (SKIP_FILES.has(base)) return true;
  return false;
}

function shouldProcess(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = filePath.split(/[\\/]/).pop();
  
  // Always process these
  if (base === 'package.json' || base === 'AGENTS.md' || base === 'README.md' ||
      base === 'CONTRIBUTING.md' || base === 'install.sh' || base === 'install.ps1' ||
      base === 'config.json' || ext === '.yml' || ext === '.yaml') {
    return true;
  }
  
  // Process known text extensions
  if (TEXT_EXTS.has(ext)) return true;
  
  // Process files with no extension (like .gitignore, Makefile, etc.)
  if (ext === '') {
    const known = new Set(['.gitignore', '.gitattributes', '.npmrc', 'LICENSE', 'Makefile']);
    if (known.has(base)) return true;
  }
  
  return false;
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      if (!shouldSkip(fullPath) && shouldProcess(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function processFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { file: filePath, changed: false, error: 'Could not read (binary?)' };
  }

  const original = content;
  for (const [search, replace] of REPLACEMENTS) {
    if (content.includes(search)) {
      content = content.split(search).join(replace);
    }
  }

  if (content === original) {
    return { file: filePath, changed: false };
  }

  writeFileSync(filePath, content, 'utf-8');
  return { file: filePath, changed: true };
}

// ── MAIN ──
console.log('Scanning project files...');
const files = walk(ROOT);
console.log(`Found ${files.length} files to process.\n`);

let changedCount = 0;
const errors = [];

for (const file of files) {
  const result = processFile(file);
  if (result.error) {
    errors.push(result);
  } else if (result.changed) {
    changedCount++;
    console.log(`  ✓ ${relative(ROOT, result.file)}`);
  }
}

console.log(`\nDone. ${changedCount} files changed.`);
if (errors.length > 0) {
  console.log(`${errors.length} errors:`);
  for (const e of errors) console.log(`  ✗ ${e.file}: ${e.error}`);
}
