/** Provider-owned identity recorded in the exclusive computer-use registration. */
export type ComputerUseProviderId = 'cua-driver-mcp';

/**
 * Desktop permission modes the driver fixes at launch. A running driver must
 * be restarted to change mode, so this travels as process environment rather
 * than as a per-call argument.
 */
export const COMPUTER_USE_PERMISSION_MODES = ['standard', 'bounded', 'unrestricted'] as const;

export type ComputerUsePermissionMode = (typeof COMPUTER_USE_PERMISSION_MODES)[number];

/**
 * Everything the runtime needs to reach one computer-use provider.
 *
 * The capability itself owns no operations: the provider's own tool catalog
 * defines what can be observed and driven, and these fields only carry what is
 * required to launch it and to name it in diagnostics.
 */
export interface ComputerUseProviderDescriptor {
  readonly id: ComputerUseProviderId;
  /** Human-readable provider name for settings screens and logs. */
  readonly label: string;
  /** MCP server name; determines the `mcp__<server>__<tool>` tool namespace. */
  readonly serverName: string;
  /** Namespace prefix every provider tool is published under. */
  readonly toolNamePrefix: string;
  /** Command used when neither config nor detection resolves a driver path. */
  readonly defaultCommand: string;
  /** Arguments that put the driver into its stdio MCP serving mode. */
  readonly defaultArgs: readonly string[];
  readonly docsUrl: string;
}

/** Lifecycle phase of the capability inside one Session. */
export type ComputerUsePhase = 'idle' | 'starting' | 'active' | 'failed';

/** Observable capability state, mirrored onto the wire for both clients. */
export interface ComputerUseStatus {
  readonly phase: ComputerUsePhase;
  readonly providerId: ComputerUseProviderId;
  readonly label: string;
  readonly serverName: string;
  /** Provider tools currently registered on the main agent. */
  readonly toolCount: number;
  readonly permissionMode: ComputerUsePermissionMode;
  readonly error?: string | undefined;
}

/** Operator-controlled inputs for activating the capability. */
export interface ComputerUseActivationSettings {
  readonly providerId?: ComputerUseProviderId | undefined;
  /** Explicit driver path or command; detection fills this in when omitted. */
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly permissionMode?: ComputerUsePermissionMode | undefined;
}
