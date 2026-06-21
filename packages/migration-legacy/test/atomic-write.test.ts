import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/atomic-write.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-write-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  // POSIX-only: Windows/NTFS does not implement POSIX permission bits, so
  // `writeFile({ mode })` / `chmod` only toggle the read-only flag and
  // `stat().mode & 0o777` reports 0o666, never 0o600. The 0600 guarantee is a
  // real security property on the platforms the migrator runs against
  // (Linux/macOS `~/.lmcode`); it is simply unrepresentable on Windows.
  it.skipIf(process.platform === 'win32')(
    'writes the target file with private 0600 permissions',
    async () => {
      // Migrated config files carry provider API keys — they must not be
      // group/world-readable regardless of the target directory's mode.
      const path = join(dir, 'config.toml');
      await atomicWrite(path, 'api_key = "secret"\n');
      expect(await readFile(path, 'utf-8')).toBe('api_key = "secret"\n');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );
});
