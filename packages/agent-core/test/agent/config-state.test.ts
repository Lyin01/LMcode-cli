import { describe, expect, it } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';

describe('ConfigState model capabilities', () => {
  it('computes provider and model capabilities from ProviderManager metadata', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            scream: {
              type: 'lmcode',
              apiKey: 'test-key',
            },
          },
          models: {
            'lmcode/lmcode-for-coding': {
              provider: 'lmcode',
              model: 'lmcode-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'lmcode/lmcode-for-coding' });

    expect(config.model).toBe('lmcode/lmcode-for-coding');
    expect(config.providerConfig.model).toBe('lmcode-for-coding');
    expect(config.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Scream capabilities from the provider catalogue', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            scream: {
              type: 'lmcode',
              apiKey: 'test-key',
            },
          },
          models: {
            'lmcode': {
              provider: 'lmcode',
              model: 'lmcode',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'lmcode' });

    expect(config.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      audio_in: false,
      max_context_tokens: 128_000,
    });
  });

it('uses session id as a provider prompt cache hint without storing it on Agent', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        promptCacheKey: 'session-test',
        config: {
          providers: {
            scream: {
              type: 'lmcode',
              apiKey: 'test-key',
            },
          },
          models: {
            'lmcode': {
              provider: 'lmcode',
              model: 'lmcode',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'lmcode' });

    expect(config.providerConfig).toMatchObject({
      type: 'lmcode',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx.agent).toBe(false);
  });
});
