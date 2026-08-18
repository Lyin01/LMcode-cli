import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureTamperDetails } from './fixture-guard';

describe('fixtureTamperDetails', () => {
  it('returns undefined when protected files match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmcode-eval-fixture-'));
    await writeFile(join(dir, 'check.mjs'), 'ok\n', 'utf-8');
    await expect(fixtureTamperDetails(dir, { 'check.mjs': 'ok\n' })).resolves.toBeUndefined();
  });

  it('reports edited and missing protected files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmcode-eval-fixture-'));
    await writeFile(join(dir, 'check.mjs'), 'tampered\n', 'utf-8');
    const details = await fixtureTamperDetails(dir, {
      'check.mjs': 'ok\n',
      'test/run.mjs': 'suite\n',
    });
    expect(details).toMatch(/check\.mjs/);
    expect(details).toMatch(/test\/run\.mjs \(missing\)/);
  });
});
