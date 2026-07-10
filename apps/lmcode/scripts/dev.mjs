#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

const env = { ...process.env };

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const child = spawn(
  process.execPath,
  [TSX_CLI, '--import', '../../build/register-raw-text-loader.mjs', './src/main.ts', ...cliArgs],
  {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(`Failed to start LMcode dev CLI: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
