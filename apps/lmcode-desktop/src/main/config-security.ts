import type { LmcodeConfig, LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk'
import { REDACTED_SECRET_VALUE } from '../shared/security.js'

type ProviderConfig = LmcodeConfig['providers'][string]
type ProviderConfigPatch = NonNullable<LmcodeConfigPatch['providers']>[string]
type ServicesConfig = NonNullable<LmcodeConfig['services']>
type ServiceConfig = NonNullable<ServicesConfig['lmcodeCliSearch']>
type ServiceConfigPatch = NonNullable<
  NonNullable<LmcodeConfigPatch['services']>['lmcodeCliSearch']
>

export function sanitizeConfigForRenderer(config: LmcodeConfig): LmcodeConfig {
  const providers: LmcodeConfig['providers'] = {}
  for (const [providerId, provider] of Object.entries(config.providers)) {
    providers[providerId] = sanitizeProvider(provider)
  }

  const services = config.services === undefined
    ? undefined
    : {
        ...config.services,
        lmcodeCliSearch: sanitizeService(config.services.lmcodeCliSearch),
        lmcodeCliFetch: sanitizeService(config.services.lmcodeCliFetch),
      }

  return {
    ...config,
    providers,
    services,
    // `raw` mirrors the complete TOML tree and can contain extension fields or
    // credentials unknown to this desktop UI. It never needs to cross IPC.
    raw: undefined,
  }
}

export function restoreRedactedConfigPatch(
  patch: LmcodeConfigPatch,
  current: LmcodeConfig,
): LmcodeConfigPatch {
  const providers = patch.providers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(patch.providers).map(([providerId, provider]) => [
          providerId,
          restoreProviderPatch(provider, current.providers[providerId]),
        ]),
      )

  const currentServices = current.services
  const services = patch.services === undefined
    ? undefined
    : {
        ...patch.services,
        lmcodeCliSearch: restoreServicePatch(
          patch.services.lmcodeCliSearch,
          currentServices?.lmcodeCliSearch,
        ),
        lmcodeCliFetch: restoreServicePatch(
          patch.services.lmcodeCliFetch,
          currentServices?.lmcodeCliFetch,
        ),
      }

  return { ...patch, providers, services }
}

function sanitizeProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    apiKey: maskSecret(provider.apiKey),
    oauth: provider.oauth === undefined
      ? undefined
      : { ...provider.oauth, key: REDACTED_SECRET_VALUE },
    // `env` is a legitimate API-key store (provider-usage reads keys from it),
    // so its values get the same mask/restore treatment as custom headers.
    env: maskHeaderValues(provider.env),
    customHeaders: maskHeaderValues(provider.customHeaders),
  }
}

function sanitizeService(service: ServiceConfig | undefined): ServiceConfig | undefined {
  if (service === undefined) return undefined
  return {
    ...service,
    apiKey: maskSecret(service.apiKey),
    oauth: service.oauth === undefined
      ? undefined
      : { ...service.oauth, key: REDACTED_SECRET_VALUE },
    customHeaders: maskHeaderValues(service.customHeaders),
  }
}

function restoreProviderPatch(
  patch: ProviderConfigPatch,
  current: ProviderConfig | undefined,
): ProviderConfigPatch {
  return {
    ...patch,
    apiKey: restoreSecret(patch.apiKey, current?.apiKey),
    oauth: patch.oauth === undefined
      ? undefined
      : {
          ...patch.oauth,
          key: restoreRequiredSecret(patch.oauth.key, current?.oauth?.key),
        },
    customHeaders: restoreHeaderValues(patch.customHeaders, current?.customHeaders),
    env: restoreHeaderValues(patch.env, current?.env),
  }
}

function restoreServicePatch(
  patch: ServiceConfigPatch | undefined,
  current: ServiceConfig | undefined,
): ServiceConfigPatch | undefined {
  if (patch === undefined) return undefined
  return {
    ...patch,
    apiKey: restoreSecret(patch.apiKey, current?.apiKey),
    oauth: patch.oauth === undefined
      ? undefined
      : {
          ...patch.oauth,
          key: restoreRequiredSecret(patch.oauth.key, current?.oauth?.key),
        },
    customHeaders: restoreHeaderValues(patch.customHeaders, current?.customHeaders),
  }
}

function maskSecret(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? value : REDACTED_SECRET_VALUE
}

function restoreSecret(
  value: string | undefined,
  current: string | undefined,
): string | undefined {
  if (value !== REDACTED_SECRET_VALUE) return value
  if (current === undefined) {
    throw new Error('Cannot restore a redacted secret without a stored value')
  }
  return current
}

function restoreRequiredSecret(value: string, current: string | undefined): string {
  return restoreSecret(value, current) ?? ''
}

function maskHeaderValues(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  return Object.fromEntries(
    Object.keys(headers).map((name) => [name, REDACTED_SECRET_VALUE]),
  )
}

function restoreHeaderValues(
  headers: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      restoreRequiredSecret(value, current?.[name]),
    ]),
  )
}
