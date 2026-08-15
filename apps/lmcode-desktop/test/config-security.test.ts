import { describe, expect, it } from 'vitest'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import {
  restoreRedactedConfigPatch,
  sanitizeConfigForRenderer,
} from '../src/main/config-security'
import { REDACTED_SECRET_VALUE } from '../src/shared/security'

const storedConfig: LmcodeConfig = {
  providers: {
    private: {
      type: 'openai',
      apiKey: 'test-key',
      customHeaders: {
        Authorization: 'Bearer provider-token',
        'X-Private-Value': 'sensitive-header',
      },
      oauth: { storage: 'keyring', key: 'provider-oauth-record' },
      env: {
        ANTHROPIC_API_KEY: 'sk-env-secret',
        CUSTOM_ENDPOINT_TOKEN: 'env-token',
      },
    },
  },
  services: {
    lmcodeCliSearch: {
      apiKey: 'test-service',
      customHeaders: { Authorization: 'Bearer service-token' },
    },
  },
  raw: {
    providers: { private: { api_key: 'test-raw' } },
  },
}

describe('desktop config secret boundary', () => {
  it('never returns provider, service, header, OAuth, or raw TOML secrets to the renderer', () => {
    const config = sanitizeConfigForRenderer(storedConfig)

    expect(config.providers.private?.apiKey).toBe(REDACTED_SECRET_VALUE)
    expect(config.providers.private?.customHeaders).toEqual({
      Authorization: REDACTED_SECRET_VALUE,
      'X-Private-Value': REDACTED_SECRET_VALUE,
    })
    expect(config.providers.private?.oauth?.key).toBe(REDACTED_SECRET_VALUE)
    expect(config.providers.private?.env).toEqual({
      ANTHROPIC_API_KEY: REDACTED_SECRET_VALUE,
      CUSTOM_ENDPOINT_TOKEN: REDACTED_SECRET_VALUE,
    })
    expect(config.services?.lmcodeCliSearch?.apiKey).toBe(REDACTED_SECRET_VALUE)
    expect(config.services?.lmcodeCliSearch?.customHeaders).toEqual({
      Authorization: REDACTED_SECRET_VALUE,
    })
    expect(config.raw).toBeUndefined()
  })

  it('preserves stored secrets when a renderer submits redacted placeholders', () => {
    const patch = restoreRedactedConfigPatch(
      {
        providers: {
          private: {
            enabled: false,
            apiKey: REDACTED_SECRET_VALUE,
            customHeaders: { Authorization: REDACTED_SECRET_VALUE },
            oauth: { storage: 'keyring', key: REDACTED_SECRET_VALUE },
            env: {
              ANTHROPIC_API_KEY: REDACTED_SECRET_VALUE,
              CUSTOM_ENDPOINT_TOKEN: 'rotated-token',
            },
          },
        },
        services: {
          lmcodeCliSearch: {
            apiKey: REDACTED_SECRET_VALUE,
            customHeaders: { Authorization: REDACTED_SECRET_VALUE },
          },
        },
      },
      storedConfig,
    )

    expect(patch.providers?.private?.apiKey).toBe('test-key')
    expect(patch.providers?.private?.customHeaders).toEqual({
      Authorization: 'Bearer provider-token',
    })
    expect(patch.providers?.private?.oauth?.key).toBe('provider-oauth-record')
    expect(patch.providers?.private?.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-env-secret',
      CUSTOM_ENDPOINT_TOKEN: 'rotated-token',
    })
    expect(patch.services?.lmcodeCliSearch?.apiKey).toBe('test-service')
  })
})
