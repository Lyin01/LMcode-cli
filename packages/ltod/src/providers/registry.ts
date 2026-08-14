import type { ChatProvider } from '../provider';

type ProviderFactory = (config: unknown) => ChatProvider;

/**
 * Registry of LLM provider factories keyed by provider type name.
 *
 * This is the ltod analogue of a plugin extension point (mirroring
 * DeepSeek Harness's "register your adapter on `ctx.llm`"): any code can
 * register a factory for a new provider type, and {@link createProvider}
 * dispatches through this registry instead of a hardcoded switch.
 *
 * The type name is the extension contract: `config` is passed to the
 * factory exactly as given at registration time, and the caller of
 * {@link create} is responsible for the shape of its own options.
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  /**
   * Registers a provider factory under `type`. Duplicate registration of
   * the same type is an error rather than a silent override, so conflicting
   * registrations surface immediately instead of producing unpredictable
   * behavior.
   */
  register<TOptions>(type: string, factory: (config: TOptions) => ChatProvider): void {
    if (this.factories.has(type)) {
      throw new Error(`Provider type already registered: ${type}`);
    }
    this.factories.set(type, factory as ProviderFactory);
  }

  /**
   * Creates a provider instance for `type` by invoking its registered
   * factory with `config`. Throws if no factory is registered for `type`.
   */
  create(type: string, config: unknown): ChatProvider {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Unknown provider type: ${String(type)}`);
    }
    return factory(config);
  }

  /** Whether a factory is registered for `type`. */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /** All registered provider type names, in registration order. */
  types(): readonly string[] {
    return [...this.factories.keys()];
  }
}
