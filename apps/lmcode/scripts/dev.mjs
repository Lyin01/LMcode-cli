#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

const env = { ...process.env };
const configuredDevelopmentHome = env.LMCODE_DEVELOPMENT_HOME?.trim();
const configuredProductionHome = env.LMCODE_HOME?.trim();
const developmentHome = configuredDevelopmentHome
  ? resolve(configuredDevelopmentHome)
  : resolve(homedir(), '.lmcode-development');
const productionHome = configuredProductionHome
  ? resolve(configuredProductionHome)
  : resolve(homedir(), '.lmcode');
const comparableDevelopmentHome = process.platform === 'win32'
  ? developmentHome.toLowerCase()
  : developmentHome;
const comparableProductionHome = process.platform === 'win32'
  ? productionHome.toLowerCase()
  : productionHome;
if (comparableDevelopmentHome === comparableProductionHome) {
  throw new Error('LMCODE_DEVELOPMENT_HOME must not point at the production LMCODE_HOME');
}
env.LMCODE_RUNTIME_ENV = 'development';
env.LMCODE_DEVELOPMENT_HOME = developmentHome;

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const useProductionBundle = cliArgs[0] === '--built';
if (useProductionBundle) cliArgs.shift();
const childArgs = useProductionBundle
  ? [resolve(APP_ROOT, 'dist/main.mjs'), ...cliArgs]
  : [
      TSX_CLI,
      '--import',
      '../../build/register-raw-text-loader.mjs',
      './src/main.ts',
      ...cliArgs,
    ];
const child = spawn(
  process.execPath,
  childArgs,
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
