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
  const restored: ProviderConfigPatch = {
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
  // Stored secrets must never silently follow the provider to a different
  // endpoint: a compromised renderer could otherwise point `baseUrl` (or the
  // base-url env var) at its own server and let the saved key authenticate
  // there. Re-entering the credentials, or keeping the current endpoint, is
  // the only way through.
  if (
    current !== undefined &&
    providerEndpointChanged(restored, current) &&
    reusesStoredSecret(patch, current)
  ) {
    throw new Error(
      'Changing the provider baseUrl requires re-entering the stored credentials; otherwise the saved key would be sent to the new endpoint.',
    )
  }
  return restored
}

function restoreServicePatch(
  patch: ServiceConfigPatch | undefined,
  current: ServiceConfig | undefined,
): ServiceConfigPatch | undefined {
  if (patch === undefined) return undefined
  const restored: ServiceConfigPatch = {
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
  if (
    current !== undefined &&
    baseUrlChanged(
      restored.baseUrl !== undefined ? restored.baseUrl : current.baseUrl,
      current.baseUrl,
    ) &&
    reusesStoredServiceSecret(patch, current)
  ) {
    throw new Error(
      'Changing the service baseUrl requires re-entering the stored credentials; otherwise the saved key would be sent to the new endpoint.',
    )
  }
  return restored
}

const PROVIDER_ENDPOINT_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_BASE_URL'],
  openai_responses: ['OPENAI_BASE_URL'],
  lmcode: ['LMCODE_BASE_URL'],
}

const PROVIDER_API_KEY_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openai_responses: 'OPENAI_API_KEY',
  lmcode: 'LMCODE_API_KEY',
  'google-genai': 'GOOGLE_API_KEY',
}

function providerEndpointChanged(
  patch: ProviderConfigPatch,
  current: ProviderConfig,
): boolean {
  const envKeys = PROVIDER_ENDPOINT_ENV_KEYS[current.type]
  if (envKeys === undefined) return false
  const nextBaseUrl = patch.baseUrl !== undefined ? patch.baseUrl : current.baseUrl
  const nextEnv = { ...current.env, ...patch.env }
  const next = resolveEffectiveBaseUrl(nextBaseUrl, nextEnv, envKeys)
  const previous = resolveEffectiveBaseUrl(current.baseUrl, current.env, envKeys)
  return next !== undefined && next !== previous
}

function reusesStoredSecret(patch: ProviderConfigPatch, current: ProviderConfig): boolean {
  if (current.apiKey !== undefined && current.apiKey.length > 0) {
    if (patch.apiKey === undefined || isPreservedSecret(patch.apiKey)) return true
  }
  if (current.oauth !== undefined) {
    if (patch.oauth === undefined || isPreservedSecret(patch.oauth.key)) return true
  }
  const envKey = PROVIDER_API_KEY_ENV_KEYS[current.type]
  if (envKey !== undefined) {
    const storedEnvSecret = current.env?.[envKey]
    if (storedEnvSecret !== undefined && storedEnvSecret.length > 0) {
      const nextValue = patch.env?.[envKey]
      if (nextValue === undefined || isPreservedSecret(nextValue)) return true
    }
  }
  return false
}

function reusesStoredServiceSecret(
  patch: ServiceConfigPatch,
  current: ServiceConfig,
): boolean {
  if (current.apiKey !== undefined && current.apiKey.length > 0) {
    if (patch.apiKey === undefined || isPreservedSecret(patch.apiKey)) return true
  }
  if (current.oauth !== undefined) {
    if (patch.oauth === undefined || isPreservedSecret(patch.oauth.key)) return true
  }
  return false
}

function baseUrlChanged(nextValue: string | undefined, currentValue: string | undefined): boolean {
  const next = nonEmptyValue(nextValue)
  return next !== undefined && next !== nonEmptyValue(currentValue)
}

function resolveEffectiveBaseUrl(
  baseUrl: string | undefined,
  env: Record<string, string> | undefined,
  envKeys: readonly string[],
): string | undefined {
  const direct = nonEmptyValue(baseUrl)
  if (direct !== undefined) return direct
  for (const key of envKeys) {
    const value = nonEmptyValue(env?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function nonEmptyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function maskSecret(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? value : REDACTED_SECRET_VALUE
}

function isPreservedSecret(value: string | undefined): boolean {
  return value === REDACTED_SECRET_VALUE || (typeof value === 'string' && value.trim() === '')
}

function restoreSecret(
  value: string | undefined,
  current: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (isPreservedSecret(value)) {
    if (value === REDACTED_SECRET_VALUE && current === undefined) {
      throw new Error('Cannot restore a redacted secret without a stored value')
    }
    return current
  }
  return value
}

function restoreRequiredSecret(
  value: string | undefined,
  current: string | undefined,
): string {
  if (value === undefined || isPreservedSecret(value)) return current ?? ''
  return value
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
