import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LmcodeHarness } from '#/index';
import type { LmcodeError } from '#/index';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lmcode-sdk-create-'));
  tempDirs.push(dir);
  return dir;
}

// `normalizeWorkDir` walks up to the nearest project root (a dir containing
// `.git`/`package.json`). On machines where the OS temp root holds such a
// marker, bare temp dirs collapse to that ancestor. Real work dirs are project
// roots, so mark each test work dir as one.
async function makeWorkDir(): Promise<string> {
  const dir = await makeTempDir();
  await mkdir(join(dir, '.git'), { recursive: true });
  return dir;
}

// The runtime resolves paths through `pathe`, which normalizes to forward
// slashes. Mirror that here so assertions hold on Windows, where `node:path`
// produces backslashes.
function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function writeTestModelConfig(homeDir: string, modelName = 'lmcode-test-model'): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "lmcode"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."${modelName}"]
provider = "local"
model = "${modelName}"
max_context_size = 1000
`,
    'utf-8',
  );
}

describe('LmcodeHarness.createSession transport link', () => {

  it('emits session_fork with the forked session context', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const source = await harness.createSession({
        id: 'ses_fork_source',
        workDir,
      });
      const forked = await harness.forkSession({
        id: source.id,
        forkId: 'ses_fork_child',
        title: 'Forked child',
      });

      expect(forked.id).toBe('ses_fork_child');
    } finally {
      await harness.close();
    }
  });

  it('creates metadata and keeps the session active in the harness', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeWorkDir();
    await writeTestModelConfig(homeDir);
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_transport_link',
        workDir,
        model: 'lmcode-test-model',
      });

      expect(session.id).toBe('ses_transport_link');
      expect(session.workDir).toBe(toPosixPath(workDir));
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'lmcode-test-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'lmcode-test-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'lmcode-test-model',
      });
      expect(configEvent).not.toHaveProperty('provider');

      const summaries = await harness.listSessions({ workDir });
      const summary = summaries.find((item) => item.id === session.id);
      expect(summary?.sessionDir).not.toBe(toPosixPath(join(homeDir, 'sessions', session.id)));
      expect(summary?.sessionDir).toContain(toPosixPath(join(homeDir, 'sessions')));
      expect(existsSync(join(summary!.sessionDir, 'state.json'))).toBe(true);
      expect(await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8')).toContain(session.id);

      const summariesById = await harness.listSessions({ sessionId: session.id });
      expect(summariesById).toHaveLength(1);
      expect(summariesById[0]).toMatchObject({
        id: session.id,
        workDir: toPosixPath(workDir),
      });
      await expect(harness.listSessions({ sessionId: 'ses_missing' })).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts configured model aliases while creating the core session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "alias-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.alias-model]
provider = "local"
model = "real-model"
max_context_size = 1000

[thinking]
effort = "medium"
`,
      'utf-8',
    );
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_alias_model', workDir });
      expect(session.id).toBe('ses_alias_model');
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'alias-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'alias-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'alias-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('does not require provider config or API keys before prompt is implemented', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_config', workDir });
      expect(session.id).toBe('ses_empty_config');
      expect((await session.getStatus()).model).toBeUndefined();
      expect(harness.sessions.get(session.id)).toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('requires a non-empty workDir on createSession', async () => {
    const homeDir = await makeTempDir();
    const harness = new LmcodeHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({ id: 'ses_missing_workdir' } as never),
      ).rejects.toMatchObject({
        name: 'LmcodeError',
        code: 'request.work_dir_required',
      } satisfies Partial<LmcodeError>);
      await expect(
        harness.createSession({ id: 'ses_blank_workdir', workDir: '   ' }),
      ).rejects.toMatchObject({
        name: 'LmcodeError',
        code: 'request.work_dir_required',
      } satisfies Partial<LmcodeError>);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when MCP config validation fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    // Project-local mcp.json is intentionally ignored, so plant the malformed
    // file under the user home dir where the loader actually reads from.
    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf-8');
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({ id: 'ses_bad_mcp_config', workDir }),
      ).rejects.toMatchObject({
        name: 'LmcodeError',
        code: 'config.invalid',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('closes active runtime handles through closeSession, session.close, and close', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: 'ses_close_one',
      workDir,
      model: 'lmcode-test-model',
    });
    const second = await harness.createSession({
      id: 'ses_close_two',
      workDir,
      model: 'lmcode-test-model',
    });
    expect(coreSessionIds(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([second.id]);

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([]);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
    expect(coreSessionIds(harness)).toEqual([]);
  });

  it('applies initial thinking and permission runtime options', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_initial_runtime_options',
        workDir,
        thinking: 'low',
        permission: 'auto',
      });

      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'config.update',
          (event) => event['thinkingLevel'] === 'low',
        ),
      ).resolves.toMatchObject({
        type: 'config.update',
        thinkingLevel: 'low',
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });
    } finally {
      await harness.close();
    }
  });

  it('applies configured default permission mode to new sessions', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(join(homeDir, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf-8');
    const harness = new LmcodeHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_default_permission_mode',
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({ permission: 'auto' });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });

      const explicit = await harness.createSession({
        id: 'ses_default_permission_explicit_override',
        workDir,
        permission: 'manual',
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({ permission: 'manual' });
    } finally {
      await harness.close();
    }
  });
});

function coreSessionIds(harness: LmcodeHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: { readonly core: { readonly sessions: ReadonlyMap<string, unknown> } };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}
