import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'

export interface ModelEntry {
  id: string
  label: string
  provider: string
}

export function buildModelEntries(config: LmcodeConfig): ModelEntry[] {
  const entries: ModelEntry[] = []
  const providers = config.providers ?? {}
  const isEnabled = (providerId: string) => providers[providerId]?.enabled !== false

  if (config.models) {
    for (const [id, alias] of Object.entries(config.models)) {
      if (!isEnabled(alias.provider)) continue
      entries.push({
        id,
        label: alias.displayName ?? alias.model ?? id,
        provider: alias.provider,
      })
    }
  }

  if (entries.length === 0 && config.providers) {
    for (const [providerId, provider] of Object.entries(config.providers)) {
      if (provider.enabled === false) continue
      if (provider.defaultModel) {
        entries.push({
          id: `${providerId}:${provider.defaultModel}`,
          label: `${provider.defaultModel}`,
          provider: providerId,
        })
      }
    }
  }

  if (config.defaultModel && !entries.some((e) => e.id === config.defaultModel)) {
    entries.push({ id: config.defaultModel, label: config.defaultModel, provider: '' })
  }

  entries.sort((a, b) => a.label.localeCompare(b.label))
  return entries
}
