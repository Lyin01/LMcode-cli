/**
 * MCP servers written in Rust publish unsigned integer formats (`uint32`,
 * `uint64`) that `ajv-formats` does not know. Ajv logs a warning for every
 * unknown format it drops, and that output lands on stdout during a tool call —
 * which corrupts terminal rendering. These tests pin both halves of the fix:
 * the formats validate as unsigned integers, and compiling such a schema stays
 * silent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';

/** The shape the Cua Driver publishes for a window handle. */
const RUST_STYLE_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      anyOf: [
        {
          oneOf: [
            {
              type: 'object',
              properties: {
                pid: { type: 'integer', format: 'uint32', minimum: 0 },
                window_id: { type: 'integer', format: 'uint64', minimum: 0 },
              },
            },
          ],
        },
      ],
    },
  },
  additionalProperties: false,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool argument validation for unsigned integer formats', () => {
  it('compiles a schema using uint32/uint64 without logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const validator = compileToolArgsValidator(RUST_STYLE_SCHEMA);

    expect(validateToolArgs(validator, { target: { pid: 2360, window_id: 1378686 } })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('accepts non-negative integers and rejects negatives for both formats', () => {
    const validator = compileToolArgsValidator(RUST_STYLE_SCHEMA);

    expect(validateToolArgs(validator, { target: { pid: 0, window_id: 0 } })).toBeNull();
    expect(validateToolArgs(validator, { target: { pid: 4_294_967_295, window_id: 5 } })).toBeNull();

    expect(validateToolArgs(validator, { target: { pid: -1, window_id: 5 } })).not.toBeNull();
    expect(validateToolArgs(validator, { target: { pid: 2.5, window_id: 5 } })).not.toBeNull();
    expect(validateToolArgs(validator, { target: { pid: 4_294_967_296, window_id: 5 } })).not.toBeNull();
  });
});
