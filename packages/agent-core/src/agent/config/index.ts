import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type ModelCapability,
  type ProviderConfig,
} from '@lmcode-cli/ltod';

import type { Agent } from '..';
import { ErrorCodes, LmcodeError } from '../../errors';
import type { AgentConfigData, AgentConfigUpdateData } from './types';
import { resolveThinkingEffort, type ThinkingEffort } from './thinking';
import type { ResolvedRuntimeProvider } from '../../session/provider-manager';

export * from './types';
export { resolveThinkingEffort, type ThinkingEffort } from './thinking';

export class ConfigState {
  private _cwd: string;
  private _modelAlias: string | undefined;
  private _profileName: string | undefined;
  private _thinkingLevel: ThinkingEffort = 'off';
  private _systemPrompt: string = '';

  constructor(protected readonly agent: Agent) {
    this._cwd = agent.jian.getcwd();
    this._modelAlias = agent.modelProvider?.defaultModel;
  }

  update(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;

    this.agent.records.logRecord({
      type: 'config.update',
      ...changed,
    });
    this.agent.replayBuilder.push({
      type: 'config_updated',
      config: changed,
    });
    if (changed.cwd) {
      this._cwd = changed.cwd;
      void this.agent.jian.chdir(changed.cwd);
    }
    if (changed.modelAlias) {
      this._modelAlias = changed.modelAlias;
    }
    if (changed.profileName) {
      this._profileName = changed.profileName;
    }
    if (changed.thinkingLevel !== undefined) {
      this._thinkingLevel = resolveThinkingEffort(
        changed.thinkingLevel,
        this.agent.lmcodeConfig?.thinking,
      );
    }
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }
    if (this.hasProvider && (changed.cwd !== undefined || changed.modelAlias)) {
      this.agent.tools.initializeBuiltinTools();
    }
    this.agent.emitStatusUpdated();
  }

  data(): AgentConfigData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this._modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
    };
  }

  get cwd(): string {
    return this._cwd;
  }

  get hasModel(): boolean {
    return this._modelAlias !== undefined;
  }

  get hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new LmcodeError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  get provider(): ChatProvider {
    return createProvider(this.providerConfig);
  }

  /**
   * Provider for low-stakes "utility" LLM calls (compaction, exit memory
   * extraction, /side questions). Resolves the optional `utility_model` alias
   * so summary-grade work can run on a cheaper model than the main agent.
   * Falls back to the main provider when unset, equal to the main model, or
   * mis-resolved — utility routing must never break the primary flow.
   */
  get utilityProvider(): ChatProvider {
    const alias = this.agent.lmcodeConfig?.utilityModel;
    if (alias === undefined || alias === this._modelAlias) return this.provider;
    try {
      const resolved = this.agent.modelProvider?.resolveProviderConfig(alias);
      return resolved === undefined ? this.provider : createProvider(resolved.provider);
    } catch {
      return this.provider;
    }
  }

  get model(): string {
    if (this._modelAlias === undefined) {
      throw new LmcodeError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return this._modelAlias;
  }

  get modelAlias(): string | undefined {
    return this._modelAlias;
  }

  get thinkingLevel(): ThinkingEffort {
    return this._thinkingLevel;
  }

  get profileName(): string | undefined {
    return this._profileName;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get modelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    if (this._modelAlias === undefined) return undefined;
    return this.agent.modelProvider?.resolveProviderConfig(this._modelAlias);
  }

  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }
}
