import type { ChatProvider } from '../provider';
import { ProviderRegistry } from './registry';
import { AnthropicChatProvider, type AnthropicOptions } from './anthropic';
import { GoogleGenAIChatProvider, type GoogleGenAIOptions } from './google-genai';
import { LmcodeChatProvider, type LmcodeOptions } from './lmcode';
import { OpenAILegacyChatProvider, type OpenAILegacyOptions } from './openai-legacy';
import { OpenAIResponsesChatProvider, type OpenAIResponsesOptions } from './openai-responses';

export type ProviderConfig =
  | ({ type: 'anthropic' } & AnthropicOptions)
  | ({ type: 'openai' } & OpenAILegacyOptions)
  | ({ type: 'lmcode' } & LmcodeOptions)
  | ({ type: 'google-genai' } & GoogleGenAIOptions)
  | ({ type: 'openai_responses' } & OpenAIResponsesOptions)
  | ({ type: 'vertexai' } & GoogleGenAIOptions);

export type ProviderType = ProviderConfig['type'];

// ---------------------------------------------------------------------------
// Built-in provider registration
// ---------------------------------------------------------------------------
//
// Built-ins are registered on the shared registry at module load. External
// code can extend the registry with its own providers through
// `registerProvider`; `createProvider` dispatches through it, so adding a
// provider never requires editing this switch.
// ---------------------------------------------------------------------------

const registry = new ProviderRegistry();

registry.register<AnthropicOptions>('anthropic', (config) => new AnthropicChatProvider(config));
registry.register<OpenAILegacyOptions>('openai', (config) => new OpenAILegacyChatProvider(config));
registry.register<LmcodeOptions>('lmcode', (config) => new LmcodeChatProvider(config));
registry.register<GoogleGenAIOptions>('google-genai', (config) => new GoogleGenAIChatProvider(config));
registry.register<OpenAIResponsesOptions>(
  'openai_responses',
  (config) => new OpenAIResponsesChatProvider(config),
);
registry.register<GoogleGenAIOptions>('vertexai', (config) => new GoogleGenAIChatProvider(config));

/**
 * Registers a provider factory under `type` for {@link createProvider}.
 *
 * Registration is global and process-wide; the type name must not collide
 * with an already-registered provider. The `TOptions` type parameter is
 * the config shape your factory accepts; callers must hand back the same
 * shape when they build a provider config for this type.
 *
 * @throws if a factory for `type` is already registered.
 */
export function registerProvider<TOptions>(
  type: string,
  factory: (config: TOptions) => ChatProvider,
): void {
  registry.register(type, factory);
}

/**
 * Whether a provider factory is registered for `type`.
 */
export function hasProvider(type: string): boolean {
  return registry.has(type);
}

/**
 * All currently registered provider type names, in registration order.
 */
export function listProviderTypes(): readonly string[] {
  return registry.types();
}

export function createProvider(config: ProviderConfig): ChatProvider {
  return registry.create(config.type, config);
}
