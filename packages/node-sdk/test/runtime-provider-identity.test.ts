import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScreamConfig } from '@lmcode-cli/agent-core';
import { createLmcodeDefaultHeaders, LMCODE_PLATFORM } from '@lmcode-cli/config';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function resolveRuntimeProvider(options: {
  readonly config: ScreamConfig;
  readonly model?: string;
  readonly lmcodeRequestHeaders?: Record<string, string>;
}) {
  const manager = new ProviderManager({
    config: options.config,
    lmcodeRequestHeaders: options.lmcodeRequestHeaders,
  });
  const model = options.model ?? options.config.defaultModel;
  if (model === undefined) {
    throw new Error('No model selected');
  }
  return manager.resolveProviderConfig(model);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lmcode-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('adds lmcode-cli User-Agent and complete X-Msh headers to the default Scream provider', async () => {
    const homeDir = await makeTempDir();
    const lmcodeRequestHeaders = createLmcodeDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'scream-model',
        providers: {
          scream: {
            type: 'lmcode',
            apiKey: 'test-key',
          },
        },
        models: {
          'scream-model': {
            provider: 'lmcode',
            model: 'scream-model',
            maxContextSize: 1000,
          },
        },
      },
      lmcodeRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'lmcode',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'lmcode-cli/0.0.0-test',
        'X-Msh-Platform': LMCODE_PLATFORM,
        'X-Msh-Version': '0.0.0-test',
        'X-Msh-Device-Name': expect.any(String),
        'X-Msh-Device-Model': expect.any(String),
        'X-Msh-Os-Version': expect.any(String),
        'X-Msh-Device-Id': expect.stringMatching(/^[0-9a-f-]+$/),
      }),
    });
  });

  it('lets Scream provider customHeaders override default identity headers', async () => {
    const homeDir = await makeTempDir();
    const lmcodeRequestHeaders = createLmcodeDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: ScreamConfig = {
      providers: {
        scream: {
          type: 'lmcode',
          apiKey: 'test-key',
          customHeaders: {
            'User-Agent': 'Custom/1',
            'X-Msh-Version': 'override-version',
          },
        },
      },
      defaultProvider: 'lmcode',
      defaultModel: 'scream-model',
      models: {
        'scream-model': {
          provider: 'lmcode',
          model: 'scream-model',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      lmcodeRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'lmcode',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'Custom/1',
        'X-Msh-Version': 'override-version',
        'X-Msh-Platform': LMCODE_PLATFORM,
      }),
    });
  });

  it('does not add LMcode identity headers to non-Scream providers', async () => {
    const homeDir = await makeTempDir();
    const lmcodeRequestHeaders = createLmcodeDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: ScreamConfig = {
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
        },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      models: {
        'gpt-test': {
          provider: 'openai',
          model: 'gpt-test',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      lmcodeRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-test',
    });
    expect(resolved.provider).not.toHaveProperty('defaultHeaders');
  });
});
