import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import { getCoreVersion } from '#/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

export const LMCODE_MCP_CLIENT_NAME = 'lmcode';
// Resolved from agent-core's package.json so MCP servers see the real version
// in `initialize` (used for compatibility checks and debugging).
// `getCoreVersion()` falls back to '0.0.0' if the package.json read fails.
export const LMCODE_MCP_CLIENT_VERSION = getCoreVersion();

/**
 * Schema validator for MCP clients.
 *
 * The SDK validates a server's structured results with its own Ajv instance,
 * and `ajv-formats` knows `int32`/`int64` but not the unsigned spellings that
 * Rust-origin servers publish. Ajv logs a warning for every unknown format it
 * drops, and that output reaches stdout — where it corrupts terminal rendering
 * mid-call. Registering the two ranges keeps the schemas meaningful instead of
 * merely silencing the warning, and leaves everything else at the SDK default.
 */
export function createMcpJsonSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  // Same baseline as the SDK's own instance, so this stays a strict superset of
  // the default behaviour rather than a different validator.
  addFormats(ajv);
  ajv.addFormat('uint32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
  });
  // Above 2^53 a JavaScript number cannot represent every integer, so the
  // 64-bit bound is "non-negative integer" rather than an exact range check.
  ajv.addFormat('uint64', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= 0,
  });
  return new AjvJsonSchemaValidator(ajv);
}

/**
 * Why-context attached when a runtime client notices its underlying transport
 * has gone away on its own — i.e. {@link RuntimeMcpClient.close} was NOT
 * called. The connection manager turns this into a `failed` status so the
 * UI/SDK do not keep advertising tools backed by a dead transport.
 *
 * - `error` is the last error reported via the SDK's `onerror` channel, if
 *   any. Useful for HTTP where there is no stderr.
 * - `stderr` is the tail of bytes captured from the child process's stderr;
 *   populated only for the stdio transport.
 */
export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/**
 * Build the `RequestOptions` object accepted by the MCP SDK's `callTool`,
 * including either the configured tool-call timeout, an in-flight abort
 * signal, both, or neither. Returns `undefined` when nothing needs to be
 * passed so the SDK falls back to its defaults.
 */
export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (toolCallTimeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: toolCallTimeoutMs, signal };
}

interface SdkListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpToolDefinition(tool: SdkListedTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * Normalise the SDK's `callTool` return into liumir's {@link MCPToolResult}.
 * The SDK can return either the modern `{ content, isError }` shape or a
 * legacy `{ toolResult }` shape; we collapse the legacy shape to a single
 * text content block.
 */
export function toMcpToolResult(result: unknown): MCPToolResult {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const typed = result as { content: unknown; isError?: unknown };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'toolResult' in result) {
    const legacy = (result as { toolResult: unknown }).toolResult;
    return {
      content: [
        {
          type: 'text',
          text: typeof legacy === 'string' ? legacy : JSON.stringify(legacy),
        },
      ],
      isError: false,
    };
  }
  return { content: [], isError: false };
}

/**
 * Returns true when an MCP tool-call failure looks like a dead transport rather
 * than an application-level error. These are the cases where tearing down and
 * reconnecting the server is likely to help.
 */
export function isRetriableMcpCallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const patterns = [
    /\be?connrefused\b/,
    /\be?connreset\b/,
    /\bepipe\b/,
    /\be?netunreach\b/,
    /\be?hostunreach\b/,
    /fetch failed/,
    /transport not connected/,
    /transport closed/,
    /network error/,
    /maximum reconnection attempts/,
  ];
  return patterns.some((pattern) => pattern.test(message));
}
