import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolve } from '../../../../build/package-imports-loader.mjs';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('package imports source loader', () => {
  it('resolves #/ imports against the importing workspace package', async () => {
    const packageRoot = await createPackageFixture();
    const entry = join(packageRoot, 'src', 'entry.ts');
    const target = join(packageRoot, 'src', 'feature', 'index.ts');
    const nextResolve = vi.fn();

    await expect(
      resolve('#/feature', { parentURL: pathToFileURL(entry).href }, nextResolve),
    ).resolves.toEqual({
      url: pathToFileURL(target).href,
      shortCircuit: true,
    });
    expect(nextResolve).not.toHaveBeenCalled();
  });

  it('delegates imports that do not exist in the local package', async () => {
    const packageRoot = await createPackageFixture();
    const entry = join(packageRoot, 'src', 'entry.ts');
    const fallback = { url: 'file:///fallback.ts' };
    const nextResolve = vi.fn(async () => fallback);

    await expect(
      resolve('#/missing', { parentURL: pathToFileURL(entry).href }, nextResolve),
    ).resolves.toBe(fallback);
    expect(nextResolve).toHaveBeenCalledWith('#/missing', {
      parentURL: pathToFileURL(entry).href,
    });
  });

  it('rejects Windows-style traversal outside the package source root', async () => {
    const packageRoot = await createPackageFixture();
    const entry = join(packageRoot, 'src', 'entry.ts');
    const fallback = { url: 'file:///fallback.ts' };
    const nextResolve = vi.fn(async () => fallback);

    await expect(
      resolve('#/..\\package.json', { parentURL: pathToFileURL(entry).href }, nextResolve),
    ).resolves.toBe(fallback);
    expect(nextResolve).toHaveBeenCalledOnce();
  });
});

async function createPackageFixture(): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'lmcode-package-loader-'));
  tempDirs.push(packageRoot);
  await mkdir(join(packageRoot, 'src', 'feature'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(packageRoot, 'src', 'feature', 'index.ts'), 'export {};\n');
  return packageRoot;
}
