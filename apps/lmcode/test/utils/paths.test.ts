import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getDataDir, getInputHistoryFile, getLogDir, getUpdateStateFile } from '#/utils/paths';

describe('getDataDir', () => {
  it('returns ~/.lmcode when LMCODE_HOME is not set', () => {
    expect(getDataDir({})).toBe(join(homedir(), '.lmcode'));
  });

  it('returns LMCODE_HOME when set', () => {
    expect(getDataDir({ LMCODE_HOME: '/tmp/lmcode-test-data' })).toBe(
      '/tmp/lmcode-test-data',
    );
  });

  it('returns LMCODE_HOME even if it is a relative path', () => {
    expect(getDataDir({ LMCODE_HOME: 'relative/path' })).toBe('relative/path');
  });

  it('uses the isolated development home for all CLI-owned data', () => {
    const environment = {
      LMCODE_RUNTIME_ENV: 'development',
      LMCODE_HOME: '/tmp/lmcode-production',
      LMCODE_DEVELOPMENT_HOME: '/tmp/lmcode-development',
    };

    expect(getDataDir(environment)).toBe('/tmp/lmcode-development');
    expect(getLogDir(environment)).toBe(join('/tmp/lmcode-development', 'logs'));
    expect(getUpdateStateFile(environment)).toBe(
      join('/tmp/lmcode-development', 'updates', 'latest.json'),
    );
  });
});

describe('getLogDir', () => {
  it('returns <dataDir>/logs', () => {
    expect(getLogDir({})).toBe(join(homedir(), '.lmcode', 'logs'));
  });

  it('respects LMCODE_HOME', () => {
    expect(getLogDir({ LMCODE_HOME: '/z' })).toBe(join('/z', 'logs'));
  });
});

describe('getUpdateStateFile', () => {
  it('returns <dataDir>/updates/latest.json', () => {
    expect(getUpdateStateFile({})).toBe(
      join(homedir(), '.lmcode', 'updates', 'latest.json'),
    );
  });

  it('respects LMCODE_HOME', () => {
    expect(getUpdateStateFile({ LMCODE_HOME: '/updates-home' })).toBe(
      join('/updates-home', 'updates', 'latest.json'),
    );
  });
});

describe('getInputHistoryFile', () => {
  it('returns <dataDir>/user-history/<md5(workDir)>.jsonl', () => {
    const workDir = '/home/user/project';
    const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
    expect(getInputHistoryFile(workDir, {})).toBe(
      join(homedir(), '.lmcode', 'user-history', `${hash}.jsonl`),
    );
  });

  it('respects LMCODE_HOME', () => {
    const hash = createHash('md5').update('/proj', 'utf-8').digest('hex');
    expect(getInputHistoryFile('/proj', { LMCODE_HOME: '/custom/data' })).toBe(
      join('/custom/data', 'user-history', `${hash}.jsonl`),
    );
  });
});
