/**
 * Detect when the agent edits fixture files the prompt said not to touch
 * (test suites, check scripts). Tampering used to inflate `passed`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function fixtureTamperDetails(
  workdir: string,
  files: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const changed: string[] = [];
  for (const [relative, expected] of Object.entries(files)) {
    let actual: string;
    try {
      actual = await readFile(join(workdir, relative), 'utf-8');
    } catch {
      changed.push(`${relative} (missing)`);
      continue;
    }
    if (actual !== expected) changed.push(relative);
  }
  if (changed.length === 0) return undefined;
  return `protected fixture files were modified: ${changed.join(', ')}`;
}
