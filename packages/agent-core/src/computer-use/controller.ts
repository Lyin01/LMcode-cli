import type { McpServerConfig } from '#/config/schema';
import { ErrorCodes, LmcodeError } from '#/errors';
import type { McpConnectionManager, McpServerEntry } from '#/mcp/connection-manager';
import type { Logger } from '#/logging/types';

import {
  COMPUTER_USE_DANGEROUSLY_BYPASS_APPROVALS_ENV,
  COMPUTER_USE_PERMISSION_MODE_ENV,
  DEFAULT_COMPUTER_USE_PERMISSION_MODE,
  DEFAULT_COMPUTER_USE_PROVIDER_ID,
  computerUseInstallRecipe,
  computerUseProvider,
  detectComputerUseDriver,
  resolveComputerUseCommand,
} from './providers';
import { ComputerUseRegistry } from './registry';
import type {
  ComputerUseActivationSettings,
  ComputerUsePermissionMode,
  ComputerUsePhase,
  ComputerUseProviderDescriptor,
  ComputerUseStatus,
} from './types';

/** Everything reserved by one successful activation. */
interface ComputerUseHold {
  readonly descriptor: ComputerUseProviderDescriptor;
  readonly release: () => void;
  readonly command: string;
  readonly args: readonly string[];
  readonly permissionMode: ComputerUsePermissionMode;
  /**
   * Whether this capability created the MCP server entry. An entry that
   * already existed belongs to the operator, so deactivation disconnects it
   * instead of deleting it.
   */
  readonly ownedEntry: boolean;
  /** Set once the provider has actually served a connection. */
  connected: boolean;
}

export interface ComputerUseControllerOptions {
  readonly mcp: McpConnectionManager;
  readonly log?: Logger;
  /** Notified on every observable phase change so clients can render status. */
  readonly onStatusChange?: (status: ComputerUseStatus) => void;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Test seam for filesystem probing of driver candidates. */
  readonly exists?: (candidate: string) => boolean;
}

/**
 * Owns the computer-use capability for one Session.
 *
 * Activation reserves the exclusive provider slot *before* any driver process
 * exists, then ensures the provider's MCP server is connected. Deactivation
 * runs the reverse order — disconnect and unregister tools first, hand the
 * slot back last — so a second driver can never go live while the first one is
 * still tearing down. A failed activation rolls back the same way and leaves
 * the slot empty.
 *
 * The controller deliberately delegates everything about *what* can be done to
 * the provider's own tool catalog: it holds no action vocabulary, no
 * screenshot type, and no per-session desktop reservation.
 */
export class ComputerUseController {
  private readonly registry = new ComputerUseRegistry();
  private readonly mcp: McpConnectionManager;
  private readonly log: Logger | undefined;
  private readonly onStatusChange: ((status: ComputerUseStatus) => void) | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly exists: ((candidate: string) => boolean) | undefined;

  private hold: ComputerUseHold | undefined;
  private lastError: string | undefined;
  private starting = false;
  private inflight: Promise<ComputerUseStatus> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(options: ComputerUseControllerOptions) {
    this.mcp = options.mcp;
    this.log = options.log;
    this.onStatusChange = options.onStatusChange;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.exists = options.exists;
  }

  /**
   * Exclusive registration slot. Exposed so callers and tests can observe that
   * a second provider is refused rather than silently replacing the first.
   */
  get providerRegistry(): ComputerUseRegistry {
    return this.registry;
  }

  /** True while a provider holds the slot and its tools are being served. */
  isActive(): boolean {
    return this.hold !== undefined && this.lastError === undefined && !this.starting;
  }

  get providerName(): string | undefined {
    return this.registry.providerName;
  }

  status(): ComputerUseStatus {
    const descriptor =
      this.hold?.descriptor ?? computerUseProvider(DEFAULT_COMPUTER_USE_PROVIDER_ID)!;
    // A released slot still reports the failure that released it: the operator
    // needs to see why nothing is running, not a bare `idle`.
    const phase: ComputerUsePhase =
      this.hold === undefined
        ? this.lastError === undefined
          ? 'idle'
          : 'failed'
        : this.starting
          ? 'starting'
          : this.lastError === undefined
            ? 'active'
            : 'failed';
    return {
      phase,
      providerId: descriptor.id,
      label: descriptor.label,
      serverName: descriptor.serverName,
      toolCount: this.hold === undefined ? 0 : (this.mcp.get(descriptor.serverName)?.toolCount ?? 0),
      permissionMode: this.hold?.permissionMode ?? DEFAULT_COMPUTER_USE_PERMISSION_MODE,
      error: this.lastError,
    };
  }

  /** Absolute driver path detected for this platform, when one is installed. */
  detectedDriverPath(): string | undefined {
    return detectComputerUseDriver(this.platform, this.env, this.exists);
  }

  /**
   * Reserve the provider slot and connect its MCP server.
   *
   * Safe to call repeatedly: a live capability returns its current status, a
   * failed one retries the connection while keeping its reservation, and
   * concurrent calls share one attempt.
   */
  async activate(settings: ComputerUseActivationSettings = {}): Promise<ComputerUseStatus> {
    if (this.inflight !== undefined) return this.inflight;
    const attempt = this.run(settings).finally(() => {
      this.inflight = undefined;
    });
    this.inflight = attempt;
    return attempt;
  }

  /**
   * Release the provider slot after its connection is gone.
   *
   * Already-delivered desktop input is not rolled back, and the provider does
   * not wait for a workflow to finish; it only waits for its own resources.
   */
  async deactivate(): Promise<void> {
    if (this.inflight !== undefined) await this.inflight.catch(() => {});
    const hold = this.hold;
    if (hold === undefined) {
      // Disabling also clears a stale failure, so a status card returns to
      // `idle` instead of repeating an error the operator already acted on.
      if (this.lastError !== undefined) {
        this.lastError = undefined;
        this.notify();
      }
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Stop the provider's tools and connection before handing back the slot;
    // releasing first would let another driver start against a live one.
    await (hold.ownedEntry
      ? this.mcp.removeServer(hold.descriptor.serverName)
      : this.mcp.stopServer(hold.descriptor.serverName)
    ).catch((error: unknown) => {
      this.log?.warn('computer use provider teardown failed', { error: describeError(error) });
    });
    hold.release();
    this.hold = undefined;
    this.lastError = undefined;
    this.notify();
  }

  /** Session shutdown: release the capability and every subscription. */
  async dispose(): Promise<void> {
    await this.deactivate();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async run(settings: ComputerUseActivationSettings): Promise<ComputerUseStatus> {
    const descriptor = this.descriptorFor(settings);
    this.starting = true;
    this.notify();
    try {
      if (descriptor === undefined) {
        // A misconfigured provider id is a configuration error, not a driver
        // failure: report it as a status instead of rejecting, so a caller
        // that enables the capability never sees an unhandled rejection.
        throw new LmcodeError(
          ErrorCodes.COMPUTER_USE_PROVIDER_UNAVAILABLE,
          `Unknown computer use provider "${settings.providerId}"`,
        );
      }
      const hold = this.hold ?? this.reserve(descriptor, settings);
      await this.ensureConnected(hold);
      this.lastError = undefined;
    } catch (error) {
      this.lastError =
        descriptor === undefined
          ? describeError(error)
          : this.describeFailure(descriptor, error);
      this.log?.warn('computer use activation failed', { error: this.lastError });
      await this.releaseNeverStartedHold();
    } finally {
      // Clear the in-flight flag before reading the status: a caller that
      // awaits activation must never receive a stale `starting` phase.
      this.starting = false;
    }
    const status = this.status();
    this.notify();
    return status;
  }

  /** Configured provider, or `undefined` when the id is not one we ship. */
  private descriptorFor(
    settings: ComputerUseActivationSettings,
  ): ComputerUseProviderDescriptor | undefined {
    const requested = settings.providerId;
    if (requested === undefined) return computerUseProvider(DEFAULT_COMPUTER_USE_PROVIDER_ID);
    return computerUseProvider(requested);
  }

  /**
   * Take the slot before anything is spawned, so a competing provider fails
   * immediately instead of racing this one for the same desktop.
   */
  private reserve(
    descriptor: ComputerUseProviderDescriptor,
    settings: ComputerUseActivationSettings,
  ): ComputerUseHold {
    const release = this.registry.register(descriptor.id);
    const configured = settings.command ?? descriptor.defaultCommand;
    const command = resolveComputerUseCommand(
      configured,
      descriptor,
      this.platform,
      this.env,
      this.exists,
    );
    const hold: ComputerUseHold = {
      descriptor,
      release,
      command,
      args: settings.args ?? descriptor.defaultArgs,
      permissionMode: settings.permissionMode ?? DEFAULT_COMPUTER_USE_PERMISSION_MODE,
      ownedEntry: this.mcp.get(descriptor.serverName) === undefined,
      connected: false,
    };
    this.hold = hold;
    return hold;
  }

  private async ensureConnected(hold: ComputerUseHold): Promise<void> {
    const { serverName } = hold.descriptor;
    const existing = this.mcp.get(serverName);
    if (existing === undefined) {
      await this.mcp.addServer(serverName, this.serverConfig(hold));
    } else if (existing.status !== 'connected') {
      await this.mcp.reconnect(serverName);
    }
    const entry = this.mcp.get(serverName);
    if (entry === undefined || entry.status !== 'connected') {
      throw new LmcodeError(
        ErrorCodes.COMPUTER_USE_PROVIDER_UNAVAILABLE,
        entry?.error ?? `Computer use provider "${serverName}" is ${entry?.status ?? 'missing'}`,
      );
    }
    hold.connected = true;
    this.watch(hold);
  }

  /**
   * Give back a reservation whose provider never came up.
   *
   * A startup failure releases the slot, so a driver that cannot launch never
   * blocks a working one. A provider that fails *after* serving keeps its
   * reservation instead: it owns the live desktop session and the operator
   * decides when to give that up. Already-delivered desktop input is never
   * rolled back either way.
   */
  private async releaseNeverStartedHold(): Promise<void> {
    const hold = this.hold;
    if (hold === undefined || hold.connected) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.hold = undefined;
    if (hold.ownedEntry) {
      await this.mcp.removeServer(hold.descriptor.serverName).catch((error: unknown) => {
        this.log?.warn('computer use cleanup failed', { error: describeError(error) });
      });
    }
    hold.release();
  }

  private serverConfig(hold: ComputerUseHold): McpServerConfig {
    return {
      transport: 'stdio',
      command: hold.command,
      args: [...hold.args],
      env: {
        [COMPUTER_USE_PERMISSION_MODE_ENV]: hold.permissionMode,
        // Unrestricted is the one mode the driver will not serve on trust:
        // without the acknowledgement variable it exits at startup
        // ("permission mode unrestricted requires --dangerously-bypass-approvals")
        // and the capability would read as a driver failure.
        ...(hold.permissionMode === 'unrestricted'
          ? { [COMPUTER_USE_DANGEROUSLY_BYPASS_APPROVALS_ENV]: '1' }
          : {}),
      },
      enabled: true,
    };
  }

  /**
   * Follow the provider's connection state. Tools are registered and
   * unregistered by the tool manager from the same status events, so this only
   * mirrors the phase and keeps the reservation honest.
   */
  private watch(hold: ComputerUseHold): void {
    this.unsubscribe?.();
    this.unsubscribe = this.mcp.onStatusChange((entry: McpServerEntry) => {
      if (entry.name !== hold.descriptor.serverName) return;
      if (entry.status === 'connected') {
        this.lastError = undefined;
      } else if (entry.status === 'failed') {
        this.lastError = entry.error ?? 'Computer use provider disconnected';
      } else if (entry.status === 'disabled') {
        this.lastError = 'Computer use provider was stopped';
      } else {
        return;
      }
      this.notify();
    });
  }

  /**
   * Wrap a provider failure with what the operator can actually do about it.
   * A missing driver is the common case after the capability is switched on
   * without the vendor package installed.
   */
  private describeFailure(descriptor: ComputerUseProviderDescriptor, error: unknown): string {
    const detail = describeError(error);
    const installed = this.detectedDriverPath() !== undefined;
    if (installed) return `${descriptor.label}: ${detail}`;
    const recipe = computerUseInstallRecipe(this.platform);
    if (recipe === undefined) return `${descriptor.label}: ${detail}`;
    return `${descriptor.label}: ${detail} — install the driver with: ${recipe.manualCommand}`;
  }

  private notify(): void {
    this.onStatusChange?.(this.status());
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
