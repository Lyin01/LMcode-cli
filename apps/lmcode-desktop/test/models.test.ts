import { describe, expect, it } from 'vitest'
import { buildModelEntries } from '../src/renderer/lib/models'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'

function makeConfig(overrides: Partial<LmcodeConfig> = {}): LmcodeConfig {
  return {
    providers: {},
    ...overrides,
  } as LmcodeConfig
}

describe('buildModelEntries', () => {
  it('lists configured model aliases with their provider', () => {
    const entries = buildModelEntries(
      makeConfig({
        providers: { kimi: { type: 'anthropic' } },
        models: {
          k3: { provider: 'kimi', model: 'kimi-k3', maxContextSize: 1_000_000, displayName: 'K3' },
        },
      }),
    )
    expect(entries).toEqual([{ id: 'k3', label: 'K3', provider: 'kimi' }])
  })

  it('hides models whose provider is disabled', () => {
    const entries = buildModelEntries(
      makeConfig({
        providers: {
          kimi: { type: 'anthropic', enabled: false },
          deepseek: { type: 'openai' },
        },
        models: {
          k3: { provider: 'kimi', model: 'kimi-k3', maxContextSize: 1_000_000 },
          ds: { provider: 'deepseek', model: 'deepseek-v3', maxContextSize: 128_000 },
        },
      }),
    )
    expect(entries.map((e) => e.id)).toEqual(['ds'])
  })

  it('hides disabled providers from the provider-default fallback', () => {
    const entries = buildModelEntries(
      makeConfig({
        providers: {
          kimi: { type: 'anthropic', enabled: false, defaultModel: 'kimi-k3' },
          deepseek: { type: 'openai', defaultModel: 'deepseek-v3' },
        },
      }),
    )
    expect(entries.map((e) => e.id)).toEqual(['deepseek:deepseek-v3'])
  })

  it('keeps the configured defaultModel selectable even when not listed', () => {
    const entries = buildModelEntries(
      makeConfig({
        providers: { kimi: { type: 'anthropic', enabled: false } },
        models: {
          k3: { provider: 'kimi', model: 'kimi-k3', maxContextSize: 1_000_000 },
        },
        defaultModel: 'k3',
      }),
    )
    expect(entries.map((e) => e.id)).toEqual(['k3'])
  })
})
