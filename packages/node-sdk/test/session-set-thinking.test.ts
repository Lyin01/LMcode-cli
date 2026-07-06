import { afterEach, describe, expect, it } from 'vitest';

import { LmcodeHarness, type LmcodeError } from '#/index';

import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setThinking', () => {
  it('sends config.update with the new thinking level', async () => {
    const homeDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-work-');
    const harness = new LmcodeHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_wire', workDir });

      await session.setThinking('low');

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
    } finally {
      await harness.close();
    }
  });

  it('rejects empty thinking levels', async () => {
    const homeDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-work-');
    const harness = new LmcodeHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_empty', workDir });

      await expect(session.setThinking('   ')).rejects.toMatchObject({
        name: 'LmcodeError',
        code: 'session.thinking_empty',
      } satisfies Partial<LmcodeError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'lmcode-sdk-thinking-work-');
    const harness = new LmcodeHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_closed', workDir });
      await session.close();

      await expect(session.setThinking('high')).rejects.toMatchObject({
        name: 'LmcodeError',
        code: 'session.closed',
      } satisfies Partial<LmcodeError>);
    } finally {
      await harness.close();
    }
  });
});
