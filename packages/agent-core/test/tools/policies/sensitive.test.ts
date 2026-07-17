import { describe, expect, it } from 'vitest';

import { isSensitiveFile } from '../../../src/tools/policies/sensitive';

describe('isSensitiveFile', () => {
  it('flags base .env files in any directory', () => {
    for (const path of ['.env', '/app/.env', 'project/.env']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags .env.<environment> variants', () => {
    for (const path of ['.env.local', '.env.production', '/app/.env.staging']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags cloud credential file locations', () => {
    for (const path of [
      '/home/user/.aws/credentials',
      '/home/user/.gcp/credentials',
      '.aws/credentials',
      '.gcp/credentials',
      'credentials',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('matches sensitive patterns case-insensitively on posix paths', () => {
    for (const path of [
      '.ENV',
      '/app/.Env.Local',
      '/home/user/.AWS/Credentials',
      '/home/user/.GCP/CREDENTIALS',
      '/home/user/.ssh/ID_RSA',
      '/home/user/.ssh/ID_ED25519.OLD',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags Windows trailing space/dot evasion variants on new files', () => {
    // Windows strips trailing spaces and dots when creating a file, so
    // `Write(C:\proj\.env )` lands on `.env`; the basename check must fold
    // those variants back instead of letting new files slip through.
    for (const path of [
      '.env ',
      '.env.',
      '.env . ',
      '/app/.env.local ',
      '.env.production ',
      'id_rsa.',
      'id_rsa ',
      '/home/user/.ssh/id_ed25519.',
      'credentials ',
      'credentials.',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('keeps exemptions and public keys non-sensitive with trailing space/dot', () => {
    for (const path of ['.env.example ', '.env.sample.', 'id_rsa.pub ', 'credentials.json ']) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });

  it('does not flag normal source / config files or env exemplars', () => {
    // Mirrors the py parametrization exactly. `.envrc`, `environment.py`,
    // `.env_example`, `server.key.example`, `id_rsa.pub`, `credentials.json`
    // (basename is `credentials.json`, not the bare `credentials` token) must
    // all pass through.
    for (const path of [
      'app.py',
      'config.yml',
      'README.md',
      'package.json',
      'server.key.example',
      'id_rsa.pub',
      'credentials.json',
      '.envrc',
      'environment.py',
      '.env_example',
      '.env.example',
      '.ENV.EXAMPLE',
      '.env.sample',
      '.ENV.SAMPLE',
      '.env.template',
      '.ENV.TEMPLATE',
      '/app/.env.example',
      '/app/.ENV.EXAMPLE',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});
