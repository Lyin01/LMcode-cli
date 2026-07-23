import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  LmcodeCore,
  type ApprovalResponse,
  type CoreAPI,
  type SDKAPI,
} from '../../src';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
  vi.restoreAllMocks();
});

describe('LmcodeCore session lifecycle', () => {
  it('rejects a duplicate active session id without replacing the running session', async () => {
    const { core, rpc, workDir } = await createCoreHarness('lmcode-core-duplicate-');
    const created = await rpc.createSession({ id: 'ses_duplicate_active', workDir });
    const active = core.sessions.get(created.id);

    await expect(
      rpc.createSession({ id: created.id, workDir }),
    ).rejects.toMatchObject({ code: 'session.already_exists' });
    expect(core.sessions.get(created.id)).toBe(active);

    await rpc.closeSession({ sessionId: created.id });
  });

  it('removes a failed-close session so it can be resumed cleanly', async () => {
    const { core, rpc, workDir } = await createCoreHarness('lmcode-core-close-');
    const created = await rpc.createSession({ id: 'ses_failed_close', workDir });
    const session = core.sessions.get(created.id)!;
    vi.spyOn(session, 'flushMetadata').mockRejectedValueOnce(new Error('flush failed'));

    await expect(rpc.closeSession({ sessionId: created.id })).rejects.toThrow('flush failed');
    expect(core.sessions.has(created.id)).toBe(false);

    const resumed = await rpc.resumeSession({ sessionId: created.id });
    expect(resumed.id).toBe(created.id);
    expect(core.sessions.get(created.id)).not.toBe(session);
    await rpc.closeSession({ sessionId: created.id });
  });
});

async function createCoreHarness(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(
    join(homeDir, 'config.toml'),
    `default_model = "default-mock"

[providers.test]
type = "lmcode"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`,
  );

  const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
  const core = new LmcodeCore(coreRpc, { homeDir });
  const rpc = await sdkRpc({
    emitEvent: vi.fn(),
    requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '' })),
  });
  return { core, rpc, workDir };
}
