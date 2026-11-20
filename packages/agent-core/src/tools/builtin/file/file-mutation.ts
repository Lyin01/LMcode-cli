import type { Jian } from '@lmcode-cli/jian';

import type { ExecutableToolResult } from '../../../loop/types';
import { resolveRealPathAccessPath, revalidateRealPathAccessPath } from '../../policies/path-access';
import type { WorkspaceConfig } from '../../support/workspace';

// ToolScheduler orders one model step. Independent sessions and subagents can
// share a filesystem, so serialize their entire read/modify/write by physical path.
const pendingWrites = new Map<string, Promise<void>>();

export async function resolveFileMutation(rawPath: string, jian: Jian, workspace: WorkspaceConfig) {
  const options = { jian, workspace, operation: 'write' as const };
  const path = await resolveRealPathAccessPath(rawPath, options);
  const key = jian.name + '\0' + (jian.pathClass() === 'win32' ? path.toLowerCase() : path);

  async function run(
    signal: AbortSignal,
    mutate: (safePath: string) => Promise<ExecutableToolResult>,
  ): Promise<ExecutableToolResult> {
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      signal.throwIfAborted();
      const safePath = await revalidateRealPathAccessPath(rawPath, path, options);
      signal.throwIfAborted();
      return mutate(safePath);
    });
    // A failed operation releases the queue just like a successful operation.
    const settled = result.then(() => undefined, () => undefined);
    pendingWrites.set(key, settled);
    try {
      return await result;
    } finally {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    }
  }

  return { path, run };
}
