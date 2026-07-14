import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

const repoRoot = resolve(import.meta.dirname, '../../../..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function workspaceManifests(): ReadonlyMap<string, PackageManifest> {
  const manifests = new Map<string, PackageManifest>();
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(repoRoot, parent);
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(parentDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson<PackageManifest>(manifestPath);
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

describe('GitHub workflow references', () => {
  it('only invokes scripts that exist in the selected workspace package', () => {
    const manifests = workspaceManifests();
    const unresolved: string[] = [];

    for (const workflow of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
      const source = readFileSync(join(workflowsDir, workflow), 'utf8');
      for (const match of source.matchAll(/pnpm\s+--filter\s+['"]?([^\s'"]+)['"]?\s+run\s+([\w:-]+)/g)) {
        const packageName = match[1]!;
        const scriptName = match[2]!;
        const manifest = manifests.get(packageName);
        if (manifest?.scripts?.[scriptName] === undefined) {
          unresolved.push(`${workflow}: ${packageName} -> ${scriptName}`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('only invokes scripts that exist in -C package directories', () => {
    const unresolved: string[] = [];

    for (const workflow of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
      const source = readFileSync(join(workflowsDir, workflow), 'utf8');
      for (const match of source.matchAll(/pnpm\s+-C\s+([^\s'"]+)\s+run\s+([\w:-]+)/g)) {
        const packageDir = match[1]!;
        const scriptName = match[2]!;
        const manifestPath = resolve(repoRoot, packageDir, 'package.json');
        if (!existsSync(manifestPath)) {
          unresolved.push(`${workflow}: missing ${packageDir}/package.json`);
          continue;
        }
        const manifest = readJson<PackageManifest>(manifestPath);
        if (manifest.scripts?.[scriptName] === undefined) {
          unresolved.push(`${workflow}: ${packageDir} -> ${scriptName}`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('resolves every local action or reusable workflow reference', () => {
    const unresolved: string[] = [];

    for (const workflow of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
      const source = readFileSync(join(workflowsDir, workflow), 'utf8');
      for (const match of source.matchAll(/uses:\s+(\.\/[^\s#]+)/g)) {
        const localReference = match[1]!;
        const target = resolve(repoRoot, localReference.slice(2));
        if (!existsSync(target) && !existsSync(join(target, 'action.yml'))) {
          unresolved.push(`${workflow}: ${localReference}`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });
});
