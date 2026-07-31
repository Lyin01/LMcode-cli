/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { join, normalize } from 'node:path';

import { resolveLmcodeHome } from '@lmcode-cli/lmcode-sdk';

import {
  LMCODE_INPUT_HISTORY_DIR_NAME,
  LMCODE_LOG_DIR_NAME,
  LMCODE_UPDATE_DIR_NAME,
  LMCODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

/**
 * Return the root data directory for LMcode.
 *
 * Uses the SDK's environment-aware resolver so development and production
 * logs, history, updates, configuration and sessions share one boundary.
 */
export function getDataDir(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const homeDir = resolveLmcodeHome(undefined, environment);
  const configuredHome = environment[
    environment['LMCODE_RUNTIME_ENV'] === 'development'
      ? 'LMCODE_DEVELOPMENT_HOME'
      : 'LMCODE_HOME'
  ];
  return configuredHome?.trim() ? homeDir : normalize(homeDir);
}

/**
 * Return the diagnostic log directory: `<dataDir>/logs/`.
 */
export function getLogDir(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return join(getDataDir(environment), LMCODE_LOG_DIR_NAME);
}

/**
 * Return the update cache file: `<dataDir>/updates/latest.json`.
 */
export function getUpdateStateFile(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  return join(getDataDir(environment), LMCODE_UPDATE_DIR_NAME, LMCODE_UPDATE_STATE_FILE_NAME);
}

/**
 * Return the user input history file for a given working directory.
 * Layout: `<share_dir>/user-history/<md5(cwd)>.jsonl`.
 */
export function getInputHistoryFile(
  workDir: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(environment), LMCODE_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
