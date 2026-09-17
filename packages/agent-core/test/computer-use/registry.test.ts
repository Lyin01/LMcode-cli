import { describe, expect, it } from 'vitest';

import { ComputerUseRegistry } from '../../src/computer-use/registry';
import { isLmcodeError } from '../../src/errors';

describe('ComputerUseRegistry', () => {
  it('reports the registered provider name until the disposer runs', () => {
    const registry = new ComputerUseRegistry();
    expect(registry.providerName).toBeUndefined();

    const release = registry.register('cua-driver-mcp');
    expect(registry.providerName).toBe('cua-driver-mcp');

    // The name stays visible while the provider tears its resources down; the
    // slot is only handed back when the provider says it is done.
    release();
    expect(registry.providerName).toBeUndefined();
  });

  it('refuses a second registration even when it repeats the current name', () => {
    const registry = new ComputerUseRegistry();
    registry.register('cua-driver-mcp');

    let thrown: unknown;
    try {
      registry.register('cua-driver-mcp');
    } catch (error) {
      thrown = error;
    }

    expect(isLmcodeError(thrown)).toBe(true);
    if (!isLmcodeError(thrown)) throw new Error('expected an LmcodeError');
    expect(thrown.code).toBe('computer_use.provider_registered');
    expect(thrown.message).toContain('already registered');
    // A refused registration must not disturb the holder.
    expect(registry.providerName).toBe('cua-driver-mcp');
  });

  it('allows a new registration once the previous holder released the slot', () => {
    const registry = new ComputerUseRegistry();
    registry.register('cua-driver-mcp')();

    expect(() => registry.register('cua-driver-mcp')).not.toThrow();
  });

  it('ignores a repeated release so a double teardown cannot free a live slot', () => {
    const registry = new ComputerUseRegistry();
    const releaseFirst = registry.register('cua-driver-mcp');
    releaseFirst();

    const releaseSecond = registry.register('cua-driver-mcp');
    releaseFirst();

    expect(registry.providerName).toBe('cua-driver-mcp');
    releaseSecond();
  });
});
